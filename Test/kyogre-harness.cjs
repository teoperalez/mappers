'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const mapperRoot = process.env.KYOGRE_MAPPER_ROOT || path.resolve(__dirname, '..');
function mapperFile(name, ext) {
  const gb = path.join(mapperRoot, 'GB', name + ext);
  return fs.existsSync(gb) ? gb : path.join(mapperRoot, name + ext);
}

// Parse the mapper's own XML, including ordered class/macro expansion. Order is
// significant: the real client invokes a property's callback immediately, before
// updating the following properties in the same notification batch.
function parseXml(source) {
  const root = { name: '#document', children: [] };
  const stack = [root];
  const cleaned = source.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '');
  for (const match of cleaned.matchAll(/<\/?[\w:-]+\b(?:[^>"']|"[^"]*"|'[^']*')*\/?\s*>/g)) {
    const token = match[0];
    if (token.startsWith('</')) { stack.pop(); continue; }
    const name = /^<([\w:-]+)/.exec(token)[1];
    const attrs = {};
    for (const attr of token.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
      attrs[attr[1]] = attr[2].replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }
    const node = { name, attrs, children: [] };
    stack.at(-1).children.push(node);
    if (!/\/\s*>$/.test(token)) stack.push(node);
  }
  return root.children[0];
}

function loadDefinitions(mapperName = 'Rayquaza_red_blue') {
  const tree = parseXml(fs.readFileSync(mapperFile(mapperName, '.xml'), 'utf8'));
  const section = name => tree.children.find(node => node.name === name);
  const templates = name => Object.fromEntries(section(name).children.map(node => [node.name, node]));
  const classes = templates('classes');
  const macros = templates('macros');
  const references = Object.fromEntries(section('references').children.map(node => [node.name,
    new Map(node.children.map(entry => [Number(entry.attrs.key), entry.attrs.value ?? null]))]));
  const definitions = [];
  const resolve = (value, vars) => value.replace(/\{([^}]+)\}/g, (_, name) => {
    assert.ok(name in vars, `Undefined XML variable ${name}`);
    return vars[name];
  });
  function walk(nodes, prefix = '', vars = {}) {
    for (const node of nodes) {
      const attrs = node.attrs;
      if (node.name === 'class' || node.name === 'macro') {
        const childVars = { ...vars };
        for (const [key, value] of Object.entries(attrs)) {
          if (key.startsWith('var:')) childVars[key.slice(4)] = resolve(value, vars);
        }
        const template = (node.name === 'class' ? classes : macros)[attrs.type];
        assert.ok(template, `Missing XML template ${attrs.type}`);
        const childPath = node.name === 'macro' ? prefix : [prefix, attrs.name].filter(Boolean).join('.');
        walk(template.children, childPath, childVars);
      } else if (node.name === 'property') {
        const addressText = attrs.address && resolve(attrs.address, vars);
        if (addressText) assert.match(addressText, /^[\da-fxA-FX\s+()-]+$/);
        definitions.push({
          path: [prefix, attrs.name].filter(Boolean).join('.'), type: attrs.type,
          address: addressText ? Function(`return (${addressText});`)() : null,
          length: Number(attrs.length || 1), bits: attrs.bits || null,
          reference: attrs.reference || (attrs.type === 'string' ? 'defaultCharacterMap' : null),
          staticValue: attrs.value == null ? undefined : attrs.type === 'int' ? Number(attrs.value) : attrs.value,
          afterReadValueExpression: attrs['after-read-value-expression'] || null,
          readFunction: attrs['read-function'] || null,
        });
      } else {
        walk(node.children, [prefix, node.name].filter(Boolean).join('.'), vars);
      }
    }
  }
  walk(section('properties').children);
  return { definitions, references };
}

function makeHarness(mapperName = 'Rayquaza_red_blue') {
  const { definitions, references } = loadDefinitions(mapperName);
  const ram = new Uint8Array(0x10000);
  const properties = {};
  const client = {};
  const notifications = [];
  const callbacks = new Map();
  const writes = [];
  let pollNumber = 0;

  for (const definition of definitions) {
    const target = { ...definition, value: null, bytes: null, bytesFrozen: null, fieldsChanged: new Set() };
    Object.defineProperty(target, 'isFrozen', { get() { return this.bytesFrozen != null; } });
    properties[target.path] = new Proxy(target, {
      set(object, key, value) {
        const old = object[key];
        const same = (key === 'bytes' || key === 'bytesFrozen') && old && value
          ? Buffer.from(old).equals(Buffer.from(value)) : old !== null && old === value;
        if (!same && key !== 'fieldsChanged') object.fieldsChanged.add(key === 'bytesFrozen' ? 'frozen' : key);
        object[key] = value;
        return true;
      },
    });
    client[target.path] = null;
  }

  function getProperty(name) { assert.ok(properties[name], `Unknown mapper property ${name}`); return properties[name]; }
  const context = vm.createContext({
    console,
    mapper: { properties, references, glossary: references },
    memory: { defaultNamespace: {
      get_byte(address) { return ram[address]; },
      get_uint16_be(address) { return (ram[address] << 8) | ram[address + 1]; },
      get_bytes(address, length) { return { data: Array.from(ram.slice(address, address + length)) }; },
    } },
    getProperty,
    getValue(name) { return getProperty(name).value; },
    setValue(name, value) { getProperty(name).value = value; },
    setProperty(name, values) { Object.assign(getProperty(name), values); },
    copyProperties(source, destination) {
      for (const prop of Object.values(properties).filter(p => p.path.startsWith(destination))) {
        const original = properties[source + prop.path.slice(destination.length)];
        if (!original) continue;
        for (const key of ['address', 'length', 'bits', 'reference', 'value', 'bytes', 'readFunction', 'afterReadValueExpression']) {
          prop[key] = original[key];
        }
      }
    },
    hpIv(ivs) { return ((ivs.attack & 1) << 3) | ((ivs.defense & 1) << 2) | ((ivs.speed & 1) << 1) | (ivs.special & 1); },
  });
  const source = fs.readFileSync(mapperFile(mapperName, '.js'), 'utf8')
    .replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*/gm, '')
    .replace(/\bexport\s+(?=(?:function|const|let|class)\b)/g, '');
  vm.runInContext(source, context, { filename: `${mapperName}.js` });

  function processProperty(prop) {
    if (prop.readFunction && context[prop.readFunction](prop) === false) return;
    if (prop.staticValue !== undefined) { prop.value = prop.staticValue; return; }
    if (prop.address == null) return;
    const bytes = Array.from(ram.slice(prop.address, prop.address + prop.length));
    // Mirrors GameHookProperty.ProcessLoop: unchanged bytes bypass decoding,
    // freezing and reference lookup, even when JS changed the prior value.
    if (prop.bytes && Buffer.from(prop.bytes).equals(Buffer.from(bytes))) return;
    prop.bytes = [...bytes];
    let numeric = bytes.reduce((value, byte) => value * 256 + byte, 0);
    if (prop.bits) {
      const bitIndexes = prop.bits.includes('-')
        ? Array.from({ length: Number(prop.bits.split('-')[1]) - Number(prop.bits.split('-')[0]) + 1 }, (_, n) => n + Number(prop.bits.split('-')[0]))
        : prop.bits.split(',').map(Number);
      numeric = bitIndexes.reduce((value, bit, index) => value | (((bytes[0] >> bit) & 1) << index), 0);
    }
    const frozenCompare = prop.bits ? [numeric] : bytes;
    if (prop.bytesFrozen && !Buffer.from(frozenCompare).equals(Buffer.from(prop.bytesFrozen))) {
      writes.push({ address: prop.address, bytes: Array.from(prop.bytesFrozen) });
      ram.set(prop.bytesFrozen, prop.address);
      return;
    }
    if (prop.type === 'string') {
      const lookup = references[prop.reference];
      let text = '';
      for (const byte of bytes) {
        const character = lookup?.get(byte);
        if (character == null) break;
        text += character;
      }
      prop.value = text;
    } else if (prop.type === 'bool') prop.value = numeric !== 0;
    else if (prop.reference) prop.value = references[prop.reference]?.get(numeric) ?? null;
    else if (prop.afterReadValueExpression) prop.value = vm.runInNewContext(prop.afterReadValueExpression, { x: numeric, Math });
    else prop.value = numeric;
  }

  function poll() {
    pollNumber++;
    for (const prop of Object.values(properties)) prop.fieldsChanged.clear();
    if (typeof context.preprocessor === 'function' && context.preprocessor() === false) return;
    for (const prop of Object.values(properties)) processProperty(prop);
    if (context.postprocessor() === false) return;
    for (const prop of Object.values(properties)) {
      if (!prop.fieldsChanged.size) continue;
      const oldValue = client[prop.path];
      client[prop.path] = prop.value;
      if (prop.fieldsChanged.has('value')) {
        const event = { poll: pollNumber, path: prop.path, value: prop.value, oldValue, state: client['meta.state'] };
        notifications.push(event);
        for (const callback of callbacks.get(prop.path) || []) callback(event);
      }
    }
  }

  function raw(name, value) {
    const prop = getProperty(name);
    assert.notEqual(prop.address, null, `Cannot write derived property ${name}`);
    let numeric = value;
    if (prop.reference && typeof value === 'string' && prop.type !== 'string') {
      numeric = [...references[prop.reference]].find(([, label]) => label === value)?.[0];
      assert.notEqual(numeric, undefined, `Unknown ${prop.reference} label ${value}`);
    }
    if (prop.bits) {
      const bit = Number(prop.bits.split('-')[0]);
      const width = prop.bits.includes('-') ? Number(prop.bits.split('-')[1]) - bit + 1 : 1;
      const mask = ((1 << width) - 1) << bit;
      ram[prop.address] = (ram[prop.address] & ~mask) | ((Number(numeric) << bit) & mask);
    } else {
      for (let n = prop.length - 1; n >= 0; n--) {
        ram[prop.address + n] = Number(numeric) & 255;
        numeric = Math.floor(Number(numeric) / 256);
      }
    }
  }

  function loadLiveSave({ id = 3384, champion = false } = {}) {
    ram.fill(0);
    // DMG-compatible Yellow reads the unused CGB WRAM bank register as FF.
    ram[0xFF70] = mapperName.endsWith('_yellow') ? 0xFF : 1;
    raw('player.player_id', id);
    raw('player.team_count', 1);
    raw('player.team.0.species', references.species.get(0xBF));
    const speciesList = getProperty('player.team_count').address + 1;
    ram[speciesList] = ram[getProperty('player.team.0.species').address];
    ram[speciesList + 1] = 0xFF;
    raw('player.team.0.level', 17);
    raw('player.team.0.stats.hp', 48);
    raw('player.team.0.stats.hp_max', 48);
    raw('player.team.0.moves.0.move', 'Ice Beam');
    raw('player.team.0.moves.1.move', 'Dragon Rage');
    raw('overworld.map_name', 'Saffron City - Gym');
    raw('flags.beat_champion', champion);
    raw('battle.mode', 0);
  }

  const app = { playerId: 3384, resets: 7, tms: 2, brokenTms: 1, optional: 4, time: '00:35:22.00', fullResets: 0, championCalls: 0, outcomes: [] };
  function on(name, callback) { callbacks.set(name, [...(callbacks.get(name) || []), callback]); }
  // Exercise the legacy renderer's consequential ordering without importing an
  // app or permitting any filesystem, network, hotkey, recording or DB actions.
  on('player.player_id', ({ value }) => {
    if (client['meta.state'] !== 'Battle' && value > 0 && value !== app.playerId) {
      app.playerId = value; app.fullResets++; app.resets = 0; app.tms = 0; app.optional = 0; app.time = '00:00:00.00';
    }
    if (value === 0 && app.playerId > 0) app.resets++;
  });
  on('flags.beat_champion', ({ value }) => {
    if (value === true && client['meta.state'] !== 'No Pokemon' && client['player.player_id'] && client['player.team_count'] && client['player.team.0.level']) app.championCalls++;
  });
  for (let index = 0; index < 4; index++) on(`player.team.0.moves.${index}.move`, ({ value }) => {
    if (value !== null && client['meta.state'] === 'Overworld' && ['Ice Beam', 'Dragon Rage'].includes(value)) app.tms++;
  });
  on('overworld.map_name', ({ value }) => { value.includes('Route'); });
  on('battle.outcome', ({ value }) => {
    if (value) app.outcomes.push(value);
    if (value === 'Lose') client['overworld.map_name'].includes('Pallet Town');
  });
  // Load() performs two reads before broadcasting MapperLoaded. The client
  // replaces its property snapshot from that payload without .change callbacks.
  function mapperLoaded() {
    for (const prop of Object.values(properties)) client[prop.path] = prop.value;
  }
  return { mapperName, properties, client, context, notifications, writes, ram, raw, loadLiveSave, poll, mapperLoaded, app, on };
}

function readyHarness(mapperName = 'Rayquaza_red_blue') {
  const h = makeHarness(mapperName);
  h.loadLiveSave();
  h.properties['player.player_id'].bytesFrozen = [13, 56];
  h.poll(); h.poll(); h.mapperLoaded();
  for (let n = 0; n < 3; n++) h.poll();
  assert.equal(h.client['player.player_id'], 3384);
  assert.equal(h.client['meta.state'], 'Overworld');
  h.notifications.length = 0;
  h.app.resets = 7; h.app.tms = 2; h.app.optional = 4; h.app.fullResets = 0; h.app.championCalls = 0; h.app.outcomes.length = 0;
  return h;
}

function resetGarbage(h, level = 255) {
  h.raw('player.team_count', 0);
  h.raw('player.team.0.level', level);
  h.raw('player.team.0.species', 255);
  h.raw('overworld.map_name', 255);
  h.raw('flags.beat_champion', true);
  h.raw('battle.mode', 'Trainer');
  h.raw('battle.opponent.trainer', 'Rival 3');
  h.raw('battle.opponent.id', 1);
  h.raw('battle.other.battle_start', 1);
  h.raw('battle.other.outcome_flags', 0);
  h.raw('battle.other.low_health_alarm', 'Disabled');
  h.raw('player.team.0.moves.0.move', 255);
}

module.exports = { makeHarness, readyHarness, resetGarbage, loadDefinitions, mapperFile };

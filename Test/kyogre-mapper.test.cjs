'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { makeHarness, readyHarness, resetGarbage, loadDefinitions, mapperFile } = require('./kyogre-harness.cjs');
const available = variant => fs.existsSync(mapperFile(`Kyogre_${variant}`, '.xml'));
assert.ok(available('red_blue') || available('yellow'), 'No Kyogre mapper found');

// The harness expands these actual mapper XMLs, decodes WRAM and runs their
// actual JavaScript. It has no filesystem writes, networking, app or OS input.
for (const [variant, game, first] of [['red_blue', 'Red and Blue', 0xAD], ['yellow', 'Yellow', 0xAC]]) {
  const name = `Kyogre_${variant}`;
  if (!available(variant)) continue; // A private game archive contains its own pair.
  test(`${name}: canonical identity, species/dex/types and active HP survive party/battle processing`, () => {
    const { definitions } = loadDefinitions(name);
    assert.equal(new Set(definitions.map(p => p.path)).size, definitions.length);
    const h = readyHarness(name);
    assert.equal(h.client['meta.game_name'], game);
    assert.equal(h.client['meta.backport_id'], 'kyogre');
    assert.match(h.client['meta.mapper_name'], /^Kyogre /);
    assert.equal(h.client['player.team.0.species'], 'Kyogre');
    assert.equal(h.client['player.team.0.dex_number'], '152');
    for (const p of ['type_1', 'type_2']) h.raw(`player.team.0.${p}`, 'Water');
    h.raw('player.team.0.stats.hp', 75); h.raw('player.team.0.stats.hp_max', 150); h.poll();
    assert.equal(h.client['player.active_pokemon.stats.hp'], 75);
    assert.equal(h.client['player.active_pokemon.type_1'], 'Water');
    assert.equal(h.client['player.active_pokemon.type_2'], 'Water');
    h.raw('battle.mode', 'Trainer'); h.raw('battle.other.battle_start', 1);
    h.raw('battle.other.low_health_alarm', 'Enabled'); h.raw('battle.other.outcome_flags', 0);
    h.raw('battle.player.party_position', 0);
    h.raw('battle.player.active_pokemon.species', 0xBF);
    h.raw('battle.player.active_pokemon.stats.hp', 37);
    h.raw('battle.player.active_pokemon.stats.hp_max', 150); h.poll();
    assert.equal(h.client['meta.state'], 'Battle');
    assert.equal(h.client['player.active_pokemon.species'], 'Kyogre');
    assert.equal(h.client['player.active_pokemon.stats.hp'], 37);
  });

  test(`${name}: every new ROM move ID decodes in all four party slots`, () => {
    const h = readyHarness(name);
    const names = ['Scary Face', 'Water Pulse', 'Calm Mind', 'Sheer Cold', 'Water Spout'];
    for (let move = 0; move < names.length; move++) {
      for (let slot = 0; slot < 4; slot++) h.raw(`player.team.0.moves.${slot}.move`, first + move);
      h.poll();
      for (let slot = 0; slot < 4; slot++) {
        assert.equal(h.client[`player.team.0.moves.${slot}.move`], names[move]);
        assert.equal(h.client[`player.active_pokemon.moves.${slot}.move`], names[move]);
      }
    }
  });

  test(`${name}: all 256 packed weather bytes decode without pending/confusion leakage`, () => {
    const h = readyHarness(name);
    const address = h.properties['battle.other.rain_dance_turns'].address;
    for (let value = 0; value < 256; value++) {
      const count = variant === 'yellow' ? (value >> 4) & 7 : value & 127;
      h.ram[address] = value;
      if (variant === 'red_blue') h.raw('battle.other.weather', count > 0 ? 'Rain' : 'None');
      h.poll();
      assert.equal(h.client['battle.other.rain_dance_turns'], count);
      const label = count === 7 ? 'Permanent (Drizzle)' : count === 0 ? 'No rain'
        : count <= 5 ? `${count} turns` : null;
      assert.equal(h.client['battle.other.rain_duration'], label);
      assert.equal(h.client['battle.other.weather'], count > 0 ? 'Rain' : 'None');
    }
  });
}

if (available('red_blue')) {
test('Kyogre Red/Blue: bank/reset noise preserves frozen ID, cumulative progress and real battle outcomes', () => {
  const h = readyHarness('Kyogre_red_blue');
  const save = h.ram.slice(); const writes = h.writes.length;
  for (let bank = 2; bank <= 7; bank++) {
    resetGarbage(h, 0); h.raw('player.player_id', 9999); h.ram[0xFF70] = bank; h.poll();
  }
  assert.equal(h.writes.length, writes);
  assert.equal(h.notifications.length, 0);
  h.ram.set(save);
  for (const level of [255, 251, 127, 253]) { resetGarbage(h, level); h.poll(); }
  assert.equal(h.app.championCalls, 0); assert.equal(h.app.resets, 7);
  resetGarbage(h, 0); for (let n = 0; n < 6; n++) h.poll();
  assert.equal(h.client['meta.state'], 'No Pokemon');
  assert.equal(h.notifications.filter(e => e.path === 'player.player_id' && e.value === 0).length, 1);
  h.loadLiveSave({ id: 9999 }); for (let n = 0; n < 6; n++) h.poll();
  assert.equal(h.client['player.player_id'], 3384);
  assert.equal(h.app.fullResets, 0); assert.equal(h.app.resets, 8);
  assert.equal(h.app.tms, 2); assert.equal(h.app.time, '00:35:22.00');
  assert.equal(h.app.championCalls, 0); assert.deepEqual(h.app.outcomes, []);
  h.raw('battle.mode', 'Trainer'); h.raw('battle.other.battle_start', 1);
  h.raw('battle.other.low_health_alarm', 'Enabled'); h.raw('battle.other.outcome_flags', 0); h.poll();
  assert.equal(h.client['meta.state'], 'Battle');
  h.raw('battle.other.low_health_alarm', 'Disabled'); h.poll();
  assert.equal(h.client['battle.outcome'], 'Win');
  h.raw('battle.other.outcome_flags', 1); h.poll();
  assert.equal(h.client['battle.outcome'], 'Lose');
});

test('Kyogre Red/Blue: reloading on a live save does not reset progress or recharge moves', () => {
  const original = readyHarness('Kyogre_red_blue'); const h = makeHarness('Kyogre_red_blue');
  Object.assign(h.client, original.client); Object.assign(h.app, original.app, { outcomes: [] });
  h.loadLiveSave(); h.properties['player.player_id'].bytesFrozen = [13, 56];
  h.poll(); h.poll(); assert.equal(h.notifications.length, 0);
  h.mapperLoaded(); for (let n = 0; n < 4; n++) h.poll();
  assert.equal(h.client['player.player_id'], 3384);
  assert.equal(h.app.fullResets, 0); assert.equal(h.app.resets, 7);
  assert.equal(h.app.tms, 2); assert.equal(h.app.time, '00:35:22.00');
});
}

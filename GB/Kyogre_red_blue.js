import {
  copyProperties,
  getValue,
  mapper,
  memory,
  setProperty,
  setValue,
} from "../common/index.js";
import { hpIv } from "../common/pokemon.js";

const PARTY_SIZE = 6;

// Reset normalization ported from Rayquaza_red_blue.js. Addresses below
// follow this mapper XML; preserve this variant's battle postprocessor.
let framePhase = 'reset';
let recoveryIdentity = null;
let resetReadersInstalled = false;
let lastLiveTrainerId = 0;
let initialReadCount = 0;
const normalizedProperties = new Set();

export function preprocessor() {
  initialReadCount += 1;
  const ram = memory.defaultNamespace;
  // D000-DFFF is banked in this GBC hack. Its palette/reset routines select
  // banks 2-7, whose bytes are not the party, trainer ID, or event flags.
  // Skip those samples entirely, including frozen-property writes.
  if ((ram.get_byte(0xFF70) & 7) > 1) return false;
  const firstPoll = !resetReadersInstalled;
  if (!resetReadersInstalled) {
    for (const property of Object.values(mapper.properties)) {
      setProperty(property.path, { readFunction: 'readResetSafeProperty' });
    }
    resetReadersInstalled = true;
  }

  const count = ram.get_byte(0xD169);
  const species = ram.get_byte(0xD171);
  const level = ram.get_byte(0xD192);
  const id = (ram.get_byte(0xD35F) << 8) | ram.get_byte(0xD360);
  const validParty = count >= 1 && count <= PARTY_SIZE
    && species > 0 && species <= 0xBF && level >= 1 && level <= 100
    && ram.get_byte(0xD16A) === species
    && ram.get_byte(0xD16A + count) === 0xFF;

  if (!validParty || id === 0) {
    // A torn bank/save sample is not itself a reset. Wait for the cleared
    // party that the ROM publishes during boot; the supplied failing stream
    // reaches this state after its garbage levels (127-255).
    if (count !== 0 || level !== 0) {
      if (framePhase !== 'live') {
        framePhase = 'reset';
        recoveryIdentity = null;
      }
      return false;
    }
    framePhase = 'reset';
    recoveryIdentity = null;
    return;
  }
  // Loading/reloading a mapper on an already live save is not a game reset.
  if (firstPoll) {
    framePhase = 'live';
    return;
  }

  // Wait for a consistent save after reset. Publish its party/moves while
  // meta.state is still No Pokemon, then resume on the following poll. This
  // prevents reloaded TMs from being reported as newly taught moves.
  const identity = `${id}:${count}:${species}:${level}`;
  if (framePhase === 'reset') {
    if (recoveryIdentity === identity) framePhase = 'recovering';
    else recoveryIdentity = identity;
  } else if (framePhase === 'recovering') {
    if (recoveryIdentity === identity) framePhase = 'live';
    else {
      framePhase = 'reset';
      recoveryIdentity = identity;
    }
  }
}

export function readResetSafeProperty(property) {
  const path = property.path;
  const loading = framePhase !== 'live';
  let value;
  let normalize = true;
  if (loading && path === 'player.player_id') value = 0;
  else if (loading && (path === 'flags.beat_champion' || path === 'event_flags.beat_champion_rival')) value = false;
  else if (loading && path === 'battle.mode') value = null;
  else if (loading && path.startsWith('battle.')) return false;
  else if (framePhase === 'reset' && path === 'player.team_count') value = 0;
  else if (framePhase === 'reset' && /^player\.team\.\d\.level$/.test(path)) value = 0;
  else if (framePhase === 'reset' && path === 'overworld.map_name') value = property.value || '';
  else normalize = false;

  if (normalize) {
    property.value = value;
    normalizedProperties.add(path);
    return false;
  }
  if (framePhase === 'reset') return false;

  // GameHook skips decoding when raw bytes match the previous poll. Invalidate
  // only fields whose published value we normalized, so an unchanged/frozen
  // trainer ID and unchanged party levels can recover from their reset zeros.
  if (normalizedProperties.delete(path)) property.bytes = null;
  if (path === 'player.player_id' && property.isFrozen && lastLiveTrainerId > 0) {
    property.value = lastLiveTrainerId;
  }
  return true;
}

function getGamestate() {
  if (framePhase !== 'live') return 'No Pokemon';
  // FSM FOR GAMESTATE TRACKING
  // MAIN GAMESTATE: This tracks the three basic states the game can be in.
  // 1. "No Pokemon": cartridge reset; player has not received a Pokemon
  // 2. "Overworld": Pokemon in party, but not in battle
  // 3. "To Battle": Battle has started but player hasn't sent their Pokemon in yet
  // 4. "From Battle": Battle result has been decided but the battle has not transition to the overworld yet
  // 5. "Battle": In battle
  const team_0_level = getValue('player.team.0.level')
  const outcome_flags = getValue('battle.other.outcome_flags')
  const battle_start = getValue('battle.other.battle_start')
  const battle_mode = getValue('battle.mode')
  const low_health_alarm = getValue('battle.other.low_health_alarm')
  if (getValue('player.team_count') < 1 || team_0_level < 1 || team_0_level > 100) {
    return 'No Pokemon'
  }
  else if (battle_mode == null) {
    return 'Overworld'
  }
  else if (battle_start == 0) {
    return 'To Battle'
  }
  else if (low_health_alarm == 'Disabled' || outcome_flags > 0) {
    return 'From Battle'
  }
  else {
    return 'Battle'
  }
}

function getBattleOutcome(stateOverride = null) {
  const outcome_flags = getValue('battle.other.outcome_flags')
  const battle_start = getValue('battle.other.battle_start')
  const low_health_alarm = getValue('battle.other.low_health_alarm')
  const battle_mode = getValue('battle.mode')
  const team_0_level = getValue('player.team.0.level')
  const state = stateOverride || getGamestate()
  if (state !== 'From Battle') {
    return null
  }

  // Reject stale teardown/reset frames that can otherwise emit a false Win.
  if (team_0_level < 1 || team_0_level > 100 || battle_mode == null || battle_start !== 1) {
    return null
  }

  switch (state) {
    case 'From Battle':
      switch (outcome_flags) {
        case 0:
          if (low_health_alarm == 'Disabled') {
            return 'Win'
          }
          return null
        case 1:
          return 'Lose'
        case 2:
          return 'Flee'
        default:
          return null
      }
  }
  return null
}

function getPlayerPartyPosition() {
  const state = getGamestate()
  switch (state) {
    case 'Battle':
      return getValue('battle.player.party_position')
    case 'From Battle':
      return getValue('battle.player.party_position')
    default: {
      const team = [0, 1, 2, 3, 4, 5]
      for (let i = 0; i < team.length; i++) {
        if (getValue(`player.team.${i}.stats.hp`) > 0) {
          return i
        }
      }

      return 0
    }
  }
}

export function postprocessor() {
  const gamestate = getGamestate()
  const battleOutcome = getBattleOutcome(gamestate)

  setValue('meta.state', gamestate)
  setValue('battle.outcome', battleOutcome || '')

  if (framePhase === 'live') lastLiveTrainerId = getValue('player.player_id');
  if (getValue('overworld.map_name') == null) setValue('overworld.map_name', '');

  setValue('player.party_position', getPlayerPartyPosition())

  //Set player.active_pokemon properties
  const party_position_overworld = getPlayerPartyPosition()
  const party_position_battle = getValue('battle.player.party_position')
  if (gamestate === 'Battle') {
    copyProperties(`player.team.${party_position_battle}`, 'player.active_pokemon')
    copyProperties('battle.player.active_pokemon', 'player.active_pokemon')
  } else {
    setProperty('player.active_pokemon.modifiers.attack', { address: null, value: 0 })
    setProperty('player.active_pokemon.modifiers.defense', { address: null, value: 0 })
    setProperty('player.active_pokemon.modifiers.speed', { address: null, value: 0 })
    setProperty('player.active_pokemon.modifiers.special', { address: null, value: 0 })
    setProperty('player.active_pokemon.modifiers.accuracy', { address: null, value: 0 })
    setProperty('player.active_pokemon.modifiers.evasion', { address: null, value: 0 })

    setProperty('player.active_pokemon.volatile_status_conditions.confusion', { address: null, value: false })
    setProperty('player.active_pokemon.volatile_status_conditions.toxic', { address: null, value: false })
    setProperty('player.active_pokemon.volatile_status_conditions.leech_seed', { address: null, value: false })

    setProperty('player.active_pokemon.effects.bide', { address: null, value: false })
    setProperty('player.active_pokemon.effects.thrash', { address: null, value: false })
    setProperty('player.active_pokemon.effects.multi_hit', { address: null, value: false })
    setProperty('player.active_pokemon.effects.flinch', { address: null, value: false })
    setProperty('player.active_pokemon.effects.charging', { address: null, value: false })
    setProperty('player.active_pokemon.effects.multi_turn', { address: null, value: false })
    setProperty('player.active_pokemon.effects.invulnerable', { address: null, value: false })
    setProperty('player.active_pokemon.effects.bypass_accuracy', { address: null, value: false })
    setProperty('player.active_pokemon.effects.mist', { address: null, value: false })
    setProperty('player.active_pokemon.effects.focus_energy', { address: null, value: false })
    setProperty('player.active_pokemon.effects.substitute', { address: null, value: false })
    setProperty('player.active_pokemon.effects.recharge', { address: null, value: false })
    setProperty('player.active_pokemon.effects.rage', { address: null, value: false })
    setProperty('player.active_pokemon.effects.lightscreen', { address: null, value: false })
    setProperty('player.active_pokemon.effects.reflect', { address: null, value: false })
    setProperty('player.active_pokemon.effects.transformed', { address: null, value: false })

    setProperty('player.active_pokemon.counters.multi_hit', { address: null, value: 0 })
    setProperty('player.active_pokemon.counters.confusion', { address: null, value: 0 })
    setProperty('player.active_pokemon.counters.toxic', { address: null, value: 0 })
    setProperty('player.active_pokemon.counters.disable', { address: null, value: 0 })

    setProperty('player.active_pokemon.last_move.move', { address: null, value: null })
    setProperty('player.active_pokemon.last_move.effect', { address: null, value: 0 })
    setProperty('player.active_pokemon.last_move.power', { address: null, value: 0 })
    setProperty('player.active_pokemon.last_move.type', { address: null, value: null })
    setProperty('player.active_pokemon.last_move.accuracy', { address: null, value: 0 })
    setProperty('player.active_pokemon.last_move.pp_max', { address: null, value: 0 })

    copyProperties(`player.team.${party_position_overworld}`, 'player.active_pokemon')
  }

  for (let index = 0; index < PARTY_SIZE; index++) {
    const ivs = {
      attack: getValue(`player.team.${index}.ivs.attack`),
      defense: getValue(`player.team.${index}.ivs.defense`),
      special: getValue(`player.team.${index}.ivs.special`),
      speed: getValue(`player.team.${index}.ivs.speed`),
    };

    setValue(`player.team.${index}.ivs.hp`, hpIv(ivs));
  }

  // Populate GameHook's two startup reads without replaying scoring callbacks.
  if (initialReadCount <= 2) return false;
}

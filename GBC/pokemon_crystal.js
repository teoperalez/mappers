import { 
  copyProperties, 
  getValue, 
  setProperty, 
  setValue 
} from "../common/index.js";
import {
  hidden_powerPower,
  hidden_powerType,
  hpIv,
  shiny,
} from "../common/pokemon.js";

const PARTY_SIZE = 6;

export function getGamestate() {
  const team_0_level = getValue('player.team.0.level')
  const outcome_flags = getValue('battle.other.outcome_flags')
  const battle_mode = getValue('battle.mode')
  const low_health_alarm = getValue('battle.other.low_health_alarm')
  const team_0_species = getValue('player.team.0.species')
  const player_battle_species = getValue('battle.player.active_pokemon.species')
  const gamestate = getValue('meta.state')
  if (team_0_level == 0) {
    return 'No Pokemon'
  }
  else if (battle_mode == null) {
    return 'Overworld'
  }	
  // The alarm is also disabled when a single Pokemon faints. It does not
  // mean the battle has ended while either side still has a replacement.
  else if ((low_health_alarm == "Disabled" || outcome_flags > 0) &&
    (getRemainingPokemonCount('player', battle_mode) === 0 ||
      getRemainingPokemonCount('opponent', battle_mode) === 0)) {
    return 'From Battle'
  }
  else if (team_0_species == player_battle_species) {
    return 'Battle'
  }
  else if ((gamestate == 'Overworld' || gamestate == 'To Battle') && battle_mode != null) {
    return 'To Battle'
  }
  else {
    return 'Battle'
  }
}

function readBattleTeamValue(path) {
  try {
    return getValue(path);
  } catch (_) {
    return null;
  }
}

function validBattleTeamHp(hp) {
  return Number.isInteger(hp) && hp >= 0;
}

function battleTeamIdentity(root) {
  const species = readBattleTeamValue(`${root}.species`);
  const level = readBattleTeamValue(`${root}.level`);
  const hpMax = readBattleTeamValue(`${root}.stats.hp_max`);
  if (species == null || species === '' ||
    !Number.isInteger(level) || level <= 0 ||
    !Number.isInteger(hpMax) || hpMax <= 0) return null;
  return `${species}|${level}|${hpMax}`;
}

export function getRemainingPokemonCount(side, battleMode) {
  if (side !== 'player' && side !== 'opponent') return null;
  const battleRoot = `battle.${side}`;
  if (side === 'opponent' && battleMode === 'Wild') {
    // Wild encounters do not own the trainer-party memory left by a prior fight.
    const hp = readBattleTeamValue(`${battleRoot}.active_pokemon.stats.hp`);
    return validBattleTeamHp(hp) ? (hp > 0 ? 1 : 0) : null;
  }

  const teamRoot = side === 'player' ? 'player' : battleRoot;
  const teamCount = readBattleTeamValue(`${teamRoot}.team_count`);
  // Missing/uninitialized telemetry is not proof that an entire team fainted.
  if (!Number.isInteger(teamCount) || teamCount < 1 || teamCount > 6) return null;

  const activeIndex = readBattleTeamValue(`${battleRoot}.party_position`);
  const activeHp = readBattleTeamValue(`${battleRoot}.active_pokemon.stats.hp`);
  const activeIdentity = battleTeamIdentity(`${battleRoot}.active_pokemon`);
  let activeMatches = 0;
  if (activeIdentity != null) {
    for (let index = 0; index < teamCount; index++) {
      if (battleTeamIdentity(`${teamRoot}.team.${index}`) === activeIdentity) activeMatches++;
    }
  }

  let remaining = 0;
  for (let index = 0; index < teamCount; index++) {
    const memberRoot = `${teamRoot}.team.${index}`;
    let hp = readBattleTeamValue(`${memberRoot}.stats.hp`);
    if (!validBattleTeamHp(hp)) return null;
    // Battle HP can reach zero before the party record is synchronized. Use it
    // only for an unambiguous matched record: party_position can change before
    // the outgoing active alias settles, including between identical species.
    if (index === activeIndex && validBattleTeamHp(activeHp) &&
      activeIdentity != null && activeMatches === 1 &&
      battleTeamIdentity(memberRoot) === activeIdentity) hp = activeHp;
    if (hp > 0) remaining++;
  }
  return remaining;
}

export function getEncounterRate() {
  const time_of_day = getValue("time.current.time_of_day");
  const morning = getValue("overworld.encounter_rates.morning");
  const day = getValue("overworld.encounter_rates.day");
  const night = getValue("overworld.encounter_rates.night");
  const water = getValue("overworld.encounter_rates.water");
  const movement_state = getValue("overworld.movement_state");
  if (movement_state == "Surfing") {
    return water;
  }
  switch (time_of_day) {
    case "Morning":
      return morning;
    case "Day":
      return day;
    case "Night":
      return night;
    default:
      return 0;
  }
}

export function getBattleOutcome() {
  const outcome_flags = getValue('battle.other.outcome_flags')
  const gamestate = getGamestate()
  // Escaping ends an encounter without either team being knocked out. Keep
  // that result observable without bypassing the all-KO From Battle gate.
  if (gamestate !== 'Overworld' && gamestate !== 'No Pokemon' &&
    [2, 66, 130, 194].includes(outcome_flags)) return 'Flee';
  switch (gamestate) {
    case 'From Battle':
      switch (outcome_flags) {
        case 0:
        case 64:
        case 128:
        case 192:
          return 'Win'
        case 1:
        case 65:
        case 129:
        case 193:
          return 'Lose'
        default:
          return null
      }
  }
  return null
}

function getPlayerPartyPosition() {
  const gamestate = getGamestate()
  switch (gamestate) {
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
  setValue("meta.state", gamestate);
  setValue("overworld.encounter_rate", getEncounterRate());
  setValue("battle.outcome", getBattleOutcome());
  
  //Set player.active_pokemon properties
  const party_position_overworld = getPlayerPartyPosition()
  const party_position_battle = getValue('battle.player.party_position')
  setValue('player.party_position', getPlayerPartyPosition())
  if (gamestate === 'Battle') {
    copyProperties(`player.team.${party_position_battle}`, 'player.active_pokemon')
    copyProperties('battle.player.active_pokemon', 'player.active_pokemon')
  } else {
    setProperty('player.active_pokemon.modifiers.attack', { address: null, value: 0 })
    setProperty('player.active_pokemon.modifiers.defense', { address: null, value: 0 })
    setProperty('player.active_pokemon.modifiers.speed', { address: null, value: 0 })
    setProperty('player.active_pokemon.modifiers.special_attack', { address: null, value: 0 })
    setProperty('player.active_pokemon.modifiers.special_defense', { address: null, value: 0 })
    setProperty('player.active_pokemon.modifiers.accuracy', { address: null, value: 0 })
    setProperty('player.active_pokemon.modifiers.evasion', { address: null, value: 0 })

    setProperty('player.active_pokemon.volatile_status_conditions.confused', { address: null, value: false })
    setProperty('player.active_pokemon.volatile_status_conditions.toxic', { address: null, value: false })
    setProperty('player.active_pokemon.volatile_status_conditions.leech_seed', { address: null, value: false })
    setProperty('player.active_pokemon.volatile_status_conditions.curse', { address: null, value: false })
    setProperty('player.active_pokemon.volatile_status_conditions.in_love', { address: null, value: false })
    setProperty('player.active_pokemon.volatile_status_conditions.nightmare', { address: null, value: false })

    setProperty('player.active_pokemon.effects.protect', { address: null, value: false })
    setProperty('player.active_pokemon.effects.identified', { address: null, value: false })
    setProperty('player.active_pokemon.effects.perish', { address: null, value: false })
    setProperty('player.active_pokemon.effects.endure', { address: null, value: false })
    setProperty('player.active_pokemon.effects.rollout', { address: null, value: false })
    setProperty('player.active_pokemon.effects.curled', { address: null, value: false })
    setProperty('player.active_pokemon.effects.bide', { address: null, value: false })
    setProperty('player.active_pokemon.effects.rampage', { address: null, value: false })
    setProperty('player.active_pokemon.effects.in_loop', { address: null, value: false })
    setProperty('player.active_pokemon.effects.flinched', { address: null, value: false })
    setProperty('player.active_pokemon.effects.charged', { address: null, value: false })
    setProperty('player.active_pokemon.effects.underground', { address: null, value: false })
    setProperty('player.active_pokemon.effects.flying', { address: null, value: false })
    setProperty('player.active_pokemon.effects.bypass_accuracy', { address: null, value: false })
    setProperty('player.active_pokemon.effects.mist', { address: null, value: false })
    setProperty('player.active_pokemon.effects.focus_energy', { address: null, value: false })
    setProperty('player.active_pokemon.effects.substitute', { address: null, value: false })
    setProperty('player.active_pokemon.effects.recharge', { address: null, value: false })
    setProperty('player.active_pokemon.effects.rage', { address: null, value: false })
    setProperty('player.active_pokemon.effects.transformed', { address: null, value: false })
    setProperty('player.active_pokemon.effects.encored', { address: null, value: false })
    setProperty('player.active_pokemon.effects.lock_on', { address: null, value: false })
    setProperty('player.active_pokemon.effects.destiny_bond', { address: null, value: false })
    setProperty('player.active_pokemon.effects.cant_run', { address: null, value: false })

    setProperty('player.active_pokemon.counters.rollout', { address: null, value: 0 })
    setProperty('player.active_pokemon.counters.confuse', { address: null, value: 0 })
    setProperty('player.active_pokemon.counters.toxic', { address: null, value: 0 })
    setProperty('player.active_pokemon.counters.disable', { address: null, value: 0 })
    setProperty('player.active_pokemon.counters.encore', { address: null, value: 0 })
    setProperty('player.active_pokemon.counters.perish', { address: null, value: 0 })
    setProperty('player.active_pokemon.counters.fury_cutter', { address: null, value: 0 })
    setProperty('player.active_pokemon.counters.protect', { address: null, value: 0 })

    copyProperties(`player.team.${party_position_overworld}`, 'player.active_pokemon')
  }

  for (let index = 0; index < PARTY_SIZE; index++) {
    const ivs = {
      attack: getValue(`player.team.${index}.ivs.attack`),
      defense: getValue(`player.team.${index}.ivs.defense`),
      special: getValue(`player.team.${index}.ivs.special`),
      speed: getValue(`player.team.${index}.ivs.speed`),
    };

    setValue(`player.team.${index}.shiny`, shiny(ivs));
    setValue(`player.team.${index}.hidden_power.power`, hidden_powerPower(ivs));
    setValue(`player.team.${index}.hidden_power.type`, hidden_powerType(ivs));
    setValue(`player.team.${index}.ivs.hp`, hpIv(ivs));
  }
}

/**
 * Shared content identifiers.
 *
 * Kept in one dependency-free module so that enemies, rooms, biomes, upgrades
 * and progression can reference each other's ids without import cycles.
 */

export type BiomeId = 'verdant' | 'foundry' | 'abyss' | 'citadel' | 'rift' | 'void';

export type RoomArchetype =
  | 'combat'
  | 'elite'
  | 'trap'
  | 'traversal'
  | 'treasure'
  | 'challenge'
  | 'puzzle'
  | 'shop'
  | 'respite'
  | 'event'
  | 'gamble'
  | 'miniboss'
  | 'boss'
  | 'secret';

export type UpgradeFamily =
  | 'bounce'
  | 'impact'
  | 'movement'
  | 'defense'
  | 'utility'
  | 'body'
  | 'transformation';

export type UpgradeRarity = 'common' | 'uncommon' | 'rare' | 'legendary' | 'cursed';

export type ArchetypeId =
  | 'ricochet'
  | 'demolition'
  | 'lightning'
  | 'momentum'
  | 'precision'
  | 'control'
  | 'swarm'
  | 'glass'
  | 'bulwark'
  | 'trickster'
  | 'parasite';

export type CurrencyId = 'shards' | 'cores' | 'echoes' | 'relics';

export const BIOME_ORDER: BiomeId[] = ['verdant', 'foundry', 'abyss', 'citadel', 'rift', 'void'];

export const RARITY_ORDER: UpgradeRarity[] = ['common', 'uncommon', 'rare', 'legendary', 'cursed'];

export const RARITY_COLORS: Record<UpgradeRarity, string> = {
  common: '#9fb3cc',
  uncommon: '#6fd6a0',
  rare: '#6aa8f0',
  legendary: '#f0b14a',
  cursed: '#d4557a',
};

export const RARITY_WEIGHTS: Record<UpgradeRarity, number> = {
  common: 100,
  uncommon: 52,
  rare: 20,
  legendary: 5,
  cursed: 12,
};

export const ARCHETYPE_NAMES: Record<ArchetypeId, string> = {
  ricochet: 'Ricochet',
  demolition: 'Demolition',
  lightning: 'Storm',
  momentum: 'Momentum',
  precision: 'Precision',
  control: 'Control',
  swarm: 'Swarm',
  glass: 'Glass',
  bulwark: 'Bulwark',
  trickster: 'Trickster',
  parasite: 'Parasite',
};

export const CURRENCY_NAMES: Record<CurrencyId, string> = {
  shards: 'Shards',
  cores: 'Cores',
  echoes: 'Echoes',
  relics: 'Relics',
};

/**
 * Upgrade registration.
 *
 * Importing this module is what makes upgrades exist. New families are added by
 * dropping a file next to this one and appending it here; nothing else changes.
 */

import { registerUpgrades, allUpgrades, type UpgradeDef } from '../../game/upgradeSystem';
import { BOUNCE_UPGRADES } from './bounce';
import { IMPACT_UPGRADES } from './impact';
import { MOVEMENT_UPGRADES } from './movement';
import { DEFENSE_UPGRADES } from './defense';
import { UTILITY_UPGRADES } from './utility';
import { BODY_UPGRADES } from './body';
import { TRANSFORMATION_UPGRADES } from './transformation';

let registered = false;

export function installUpgradeContent(): void {
  if (registered) return;
  registered = true;
  registerUpgrades([
    ...BOUNCE_UPGRADES,
    ...IMPACT_UPGRADES,
    ...MOVEMENT_UPGRADES,
    ...DEFENSE_UPGRADES,
    ...UTILITY_UPGRADES,
    ...BODY_UPGRADES,
    ...TRANSFORMATION_UPGRADES,
  ]);
}

// Content registration is a side effect of import so that any entry point -
// the game, a test, or the balance simulator - sees the same catalogue.
installUpgradeContent();

export function upgradeCatalogue(): UpgradeDef[] {
  installUpgradeContent();
  return allUpgrades();
}

export {
  BOUNCE_UPGRADES,
  IMPACT_UPGRADES,
  MOVEMENT_UPGRADES,
  DEFENSE_UPGRADES,
  UTILITY_UPGRADES,
  BODY_UPGRADES,
  TRANSFORMATION_UPGRADES,
};

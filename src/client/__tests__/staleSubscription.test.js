import { describe, it, expect } from 'vitest';
import { staleSubscription } from '../App.jsx';

const kitlados = { id: 'old', vehicle_id: '3744614764253136', vehicle_name: 'KitlaDos' };
const kittlatres = { id: '3462774774351601', name: 'KittlaTres', state: 'offline' };

describe('staleSubscription', () => {
  it('finds a sub whose car is not on the account (the car-swap case)', () => {
    expect(staleSubscription([kitlados], [kittlatres])).toBe(kitlados);
  });
  it('control: the same sub with its car on the account is not stale', () => {
    expect(staleSubscription([{ ...kitlados, vehicle_id: kittlatres.id }], [kittlatres])).toBeNull();
  });
  it('never flags the test stub, and says nothing before the lists load', () => {
    expect(staleSubscription([{ id: 's', vehicle_id: '999999999999999' }], [kittlatres])).toBeNull();
    expect(staleSubscription(null, [kittlatres])).toBeNull();
    expect(staleSubscription([kitlados], null)).toBeNull();
  });
});

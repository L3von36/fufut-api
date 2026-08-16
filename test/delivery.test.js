import { describe, it, expect } from 'vitest';
import { canTransition, TRANSITIONS, ORDER_STATUS_TO_DELIVERY } from '../src/handlers/delivery.js';

/**
 * `delivery.status` was free text defaulting to 'pending', so every screen
 * invented its own vocabulary and a job could be marked delivered without ever
 * having been assigned to anybody. These tests pin the state machine that
 * replaced it.
 */
describe('delivery transitions', () => {
  it('walks the happy path from order to doorstep', () => {
    const path = [
      'new',
      'confirmed',
      'preparing',
      'ready',
      'assigned',
      'picked_up',
      'out_for_delivery',
      'delivered',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('lets a job go straight from new to preparing', () => {
    // A phone order the cashier takes and sends to the kitchen in one action;
    // requiring an explicit "confirmed" tap adds a step nobody performs.
    expect(canTransition('new', 'preparing')).toBe(true);
  });

  it('lets a driver mark delivered without the out-for-delivery tap', () => {
    // A short run to a neighbouring building never gets that intermediate tap,
    // and refusing it would leave the job stuck as picked_up all evening.
    expect(canTransition('picked_up', 'delivered')).toBe(true);
  });

  it('refuses delivery of something nobody is carrying', () => {
    expect(canTransition('ready', 'delivered')).toBe(false);
    expect(canTransition('new', 'delivered')).toBe(false);
    expect(canTransition('preparing', 'picked_up')).toBe(false);
  });

  it('refuses to run the sequence backwards', () => {
    expect(canTransition('delivered', 'assigned')).toBe(false);
    expect(canTransition('picked_up', 'ready')).toBe(false);
    expect(canTransition('ready', 'new')).toBe(false);
  });

  it('allows cancelling anything that has not arrived yet', () => {
    for (const s of ['new', 'confirmed', 'preparing', 'ready', 'assigned', 'picked_up']) {
      expect(canTransition(s, 'cancelled')).toBe(true);
    }
  });

  it('refuses to cancel a delivery that already happened', () => {
    // The food is with the guest. Cancelling it is a refund, which is a
    // different act with different controls.
    expect(canTransition('delivered', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'cancelled')).toBe(false);
  });

  it('treats a missing status as new rather than refusing everything', () => {
    // Rows created before migration 005 carry the old 'pending' default or an
    // empty string; they must still be movable.
    expect(canTransition(undefined, 'preparing')).toBe(true);
    expect(canTransition('', 'confirmed')).toBe(true);
  });

  it('refuses an invented status', () => {
    expect(canTransition('new', 'on_the_bike')).toBe(false);
    expect(canTransition('nonsense', 'delivered')).toBe(false);
  });

  it('is a terminal state at both ends', () => {
    expect(TRANSITIONS.delivered).toEqual([]);
    expect(TRANSITIONS.cancelled).toEqual([]);
  });
});

describe('kitchen progress mirrored onto the job', () => {
  it('maps the three kitchen states a delivery cares about', () => {
    expect(ORDER_STATUS_TO_DELIVERY.preparing).toBe('preparing');
    expect(ORDER_STATUS_TO_DELIVERY.ready).toBe('ready');
  });

  it('does not map states that would drag a job backwards', () => {
    // 'served' and 'completed' describe the order after the driver already has
    // it; mirroring them would move the job to a stage behind where it is.
    expect(ORDER_STATUS_TO_DELIVERY.served).toBeUndefined();
    expect(ORDER_STATUS_TO_DELIVERY.completed).toBeUndefined();
  });

  it('never moves a job that a driver already holds', () => {
    // The guard that makes the mirror safe: once assigned, the kitchen's view
    // of the order no longer determines where the food is.
    expect(canTransition('assigned', 'ready')).toBe(false);
    expect(canTransition('picked_up', 'preparing')).toBe(false);
  });
});

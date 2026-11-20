// auto-ship: when an order is paid, drive it to shipped through the machine.
//
// Fixed per docs/INCIDENT.md §auto-ship: the plugin awaits the machine's
// transition result and broadcasts order:shipped only when the transition
// actually applied. It never reads the store to decide, and never broadcasts
// on failure.

export function registerAutoShip({ bus, machine }) {
  if (!bus || !machine) throw new TypeError('registerAutoShip requires bus and machine');
  return bus.on('order:paid', async order => {
    const result = await machine.transition(order.id, 'ship');
    if (result.ok) {
      await bus.emit('order:shipped', { id: order.id, state: result.state, version: result.version });
    }
  });
}

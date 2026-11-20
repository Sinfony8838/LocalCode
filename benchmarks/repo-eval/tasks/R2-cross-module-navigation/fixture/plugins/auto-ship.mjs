// auto-ship: when an order is paid, drive it to shipped through the machine.
//
// Incident docs/INCIDENT.md §auto-ship describes why the current guard is
// wrong: it reads the store directly and broadcasts an event instead of
// driving the machine, so the warehouse bridge never sees the order move.

export function registerAutoShip({ bus, machine, store }) {
  if (!bus || !machine) throw new TypeError('registerAutoShip requires bus and machine');
  return bus.on('order:paid', order => {
    const snapshot = store?.get(order?.id);
    if (snapshot?.state === 'paid') {
      bus.emit('order:shipped', { id: order.id, state: snapshot.state, version: snapshot.version });
    }
  });
}

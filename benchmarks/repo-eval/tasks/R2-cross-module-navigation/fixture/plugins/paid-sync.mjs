// paid-sync: bridges the payment webhook's domain event to the machine.
// The webhook layer must not know about the machine, so this plugin performs
// the `pay` transition on the pipeline's behalf.

export function registerPaidSync({ bus, machine }) {
  if (!bus || !machine) throw new TypeError('registerPaidSync requires bus and machine');
  return bus.on('payment:settled', async order => {
    await machine.transition(order.id, 'pay', { via: 'webhook' });
  });
}

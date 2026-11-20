// notify: forwards bus traffic to the notification gateway (stubbed here).

export function registerNotify({ bus, gateway = { sent: [] } }) {
  if (!bus) throw new TypeError('registerNotify requires bus');
  return bus.on('order:shipped', payload => {
    gateway.sent.push({ template: 'order-shipped', id: payload?.id });
  });
}

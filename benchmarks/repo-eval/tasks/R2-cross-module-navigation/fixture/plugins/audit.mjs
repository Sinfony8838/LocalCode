// audit: append-only observation of bus traffic. Never mutates the store.

export function registerAudit({ bus, sink = [] }) {
  if (!bus) throw new TypeError('registerAudit requires bus');
  const off = bus.on('order:paid', payload => { sink.push({ type: 'order:paid', id: payload?.id, at: Date.now() }); });
  const offShipped = bus.on('order:shipped', payload => { sink.push({ type: 'order:shipped', id: payload?.id, at: Date.now() }); });
  return () => { off(); offShipped(); };
}

import http from 'node:http';
import { once } from 'node:events';

// Local-only protocol fixture. Requests and credentials remain in memory.
export async function providerFixture(secret) {
  const requests = [], queue = [], errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      const kind = pathname.endsWith('/messages') ? 'anthropic' : pathname.endsWith('/responses') ? 'responses' : 'openai';
      requests.push({ kind, url: req.url, body });
      if ((kind === 'anthropic' ? req.headers['x-api-key'] : req.headers.authorization?.replace(/^Bearer /, '')) !== secret) throw new Error('Wrong authentication header');
      if (kind === 'anthropic' && !req.headers['anthropic-version']) throw new Error('Missing Anthropic version');
      const next = queue.shift() || { text: '模型接口检查通过。' };
      if (next.gate) await next.gate;
      if (next.error) { res.writeHead(next.error, { 'Content-Type': 'application/json', ...next.headers }); res.end(JSON.stringify({ request_id: 'fixture-request-id', error: { code: next.error === 429 ? 'RequestBurstTooFast' : 'authentication_error', message: `Rejected key ${secret}` } })); return; }
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(kind === 'anthropic' ? { type: 'message', content: [{ type: 'text', text: 'OK' }] } : kind === 'responses' ? { object: 'response', output: [] } : { choices: [{ message: { content: 'OK' } }] })); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      const tool = next.tool;
      const parts = text => (text || '').match(/[\s\S]{1,7}/gu) || [];
      const pause = async () => { if (next.thinkingGate) await next.thinkingGate; if (next.cutAfterThinking) { res.destroy(); return true; } return false; };
      if (kind === 'anthropic') {
        event('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } });
        if (next.thinking) {
          event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
          for (const piece of parts(next.thinking)) event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: piece } });
          if (await pause()) return;
          for (const piece of parts(next.thinkingTail)) event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: piece } });
          if (next.tailGate) await next.tailGate;
          event('content_block_stop', { index: 0 });
        }
        const index = next.thinking ? 1 : 0;
        event('content_block_start', { index, content_block: tool ? { type: 'tool_use', id: 'tool_fixture', name: tool.name, input: {} } : { type: 'text', text: '' } });
        for (const piece of parts(tool ? JSON.stringify(tool.args) : next.text)) event('content_block_delta', { index, delta: tool ? { type: 'input_json_delta', partial_json: piece } : { type: 'text_delta', text: piece } });
        event('content_block_stop', { index });
        event('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
        event('message_stop', {});
      } else if (kind === 'responses') {
        event('response.created', { response: { id: 'resp_fixture', object: 'response', status: 'in_progress', output: [] } });
        if (next.thinking) {
          event('response.output_item.added', { output_index: 0, item: { id: 'reason_fixture', type: 'reasoning', summary: [] } });
          event('response.reasoning_summary_part.added', { output_index: 0, item_id: 'reason_fixture', summary_index: 0, part: { type: 'summary_text', text: '' } });
          for (const piece of parts(next.thinking)) event('response.reasoning_summary_text.delta', { output_index: 0, item_id: 'reason_fixture', summary_index: 0, delta: piece });
          if (await pause()) return;
          for (const piece of parts(next.thinkingTail)) event('response.reasoning_summary_text.delta', { output_index: 0, item_id: 'reason_fixture', summary_index: 0, delta: piece });
          if (next.tailGate) await next.tailGate;
          event('response.output_item.done', { output_index: 0, item: { id: 'reason_fixture', type: 'reasoning', summary: [{ type: 'summary_text', text: next.thinking + (next.thinkingTail || '') }] } });
        }
        const outputIndex = next.thinking ? 1 : 0;
        const item = tool ? { id: 'fc_fixture', type: 'function_call', call_id: 'call_fixture', name: tool.name, arguments: '' } : { id: 'msg_fixture', type: 'message', role: 'assistant', content: [] };
        event('response.output_item.added', { output_index: outputIndex, item });
        const content = tool ? JSON.stringify(tool.args) : next.text;
        for (const piece of parts(content)) event(tool ? 'response.function_call_arguments.delta' : 'response.output_text.delta', { output_index: outputIndex, item_id: item.id, content_index: 0, delta: piece });
        const doneItem = tool ? { ...item, arguments: content, status: 'completed' } : { ...item, status: 'completed', content: [{ type: 'output_text', text: content, annotations: [] }] };
        event('response.output_item.done', { output_index: outputIndex, item: doneItem });
        event('response.completed', { response: { id: 'resp_fixture', object: 'response', status: 'completed', output: [doneItem], usage: { input_tokens: 12, output_tokens: 10, total_tokens: 22 } } });
      } else {
        const delta = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        delta({ role: 'assistant' });
        if (next.thinking) { for (const piece of parts(next.thinking)) delta({ reasoning_content: piece }); if (await pause()) return; for (const piece of parts(next.thinkingTail)) delta({ reasoning_content: piece }); if (next.tailGate) await next.tailGate; }
        if (tool) delta({ tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] });
        else for (const piece of parts(next.text)) delta({ content: piece });
        delta({}, tool ? 'tool_calls' : 'stop'); res.write('data: [DONE]\n\n');
      }
      res.end();
    } catch (e) { errors.push(e.message); res.writeHead(500); res.end('fixture failure'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests, queue, errors, close: () => { server.closeAllConnections(); server.close(); } };
}

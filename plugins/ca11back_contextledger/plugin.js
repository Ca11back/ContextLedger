// ContextLedger request plugin for new-api apiVersion 1.
// Sends each finished request to a self-hosted ContextLedger service: https://github.com/Ca11back/ContextLedger
export const meta = {
  apiVersion: 1, key: 'ca11back_contextledger', name: 'ContextLedger', version: '0.3.0',
  author: { name: 'Ca11back', url: 'https://github.com/Ca11back' },
  description: {
    en: 'ContextLedger: save readable request and reply content for admin audit',
    'zh-CN': 'ContextLedger：保存可读的请求和回复内容，供管理员审计',
  },
  configSchema: {
    type: 'object', properties: {
      url: { type: 'string', format: 'url', title: { en: 'Ingestion URL', 'zh-CN': '接收地址' } },
      token: { type: 'string', format: 'password', title: { en: 'Ingestion token', 'zh-CN': '上传令牌' } },
      source: { type: 'string', title: { en: 'Source identity', 'zh-CN': '来源名称' } },
    }, required: ['url', 'token', 'source'],
  },
};
function utf8Length(value) { return new TextEncoder().encode(value).length; }
// Per-call budgets only; parsed host JSON and ordinary strings are never mutated.
function stripEncrypted(record) {
  const original = JSON.stringify(record);
  if (original.length > 32 * 1024 * 1024 || utf8Length(original) > 32 * 1024 * 1024) throw new Error('contextledger_profile_budget');
  const budget = { nodes: 0, fields: 0, removed: 0 };
  function visit(value, depth) {
    if (++budget.nodes > 250000 || depth > 96) throw new Error('contextledger_profile_budget');
    if (value === null || typeof value !== 'object') return value;
    const clone = Array.isArray(value) ? [] : Object.create(null);
    for (const key of Object.keys(value)) {
      if (!Array.isArray(value) && key === 'encrypted_content') {
        budget.fields++; budget.removed += utf8Length(JSON.stringify(value[key]));
      } else Object.defineProperty(clone, key, { value: visit(value[key], depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return clone;
  }
  return { report: visit(record, 0), originalBytes: utf8Length(original), fields: budget.fields, removedBytes: budget.removed };
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keysWithin(value, keys) { return object(value) && Object.keys(value).every(key => keys.indexOf(key) !== -1); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function eventType(event) {
  if (!object(event) || !object(event.data)) return '';
  if (event.event !== undefined && event.event !== event.data.type) return '';
  return typeof event.data.type === 'string' ? event.data.type : '';
}
function finalEvents(ctx, report, residue, omissions) {
  const response = report.response;
  const events = object(response) && Array.isArray(response.events) ? response.events : [];
  const result = { mode: !object(response) ? 'no_response' : response.stream === true ? 'events_retained' : 'nonstream', reason: 'not_streaming', origin: 'reported', omitted_events: 0, omitted_event_json_bytes: 0, retained_events: events.length };
  const retain = reason => { result.reason = reason; return result; };
  if (!object(response) || response.stream !== true) return result;
  if (ctx.format !== 'openai_responses') return retain('unsupported_protocol');
  if (response.truncated !== false) return retain('host_truncated_or_unknown');
  if (report.error || !(response.status >= 200 && response.status < 300)) return retain('reported_error');
  if (!events.length) return retain('missing_events');
  const terminals = events.map((event, index) => eventType(event) === 'response.completed' ? index : -1).filter(index => index !== -1);
  if (terminals.length !== 1) return retain(terminals.length ? 'ambiguous_final' : 'missing_final');
  const terminalIndex = terminals[0], terminal = events[terminalIndex], final = terminal.data.response;
  if (!object(final) || final.status !== 'completed' || !Array.isArray(final.output) || final.error || final.incomplete_details) return retain('incomplete_final');
  if (response.body !== undefined && !same(response.body, final)) return retain('existing_body_differs');
  if (final.output.some(item => !object(item) || (item.status !== undefined && item.status !== 'completed'))) return retain('incomplete_output');
  const ids = final.output.map(item => item.id).filter(id => id !== undefined);
  if (new Set(ids).size !== ids.length) return retain('ambiguous_output');
  const removable = new Set(), deltas = new Map();
  function save(index, type, position, value) { residue.push({ event_index: index, event_type: type, position, value }); }
  function extras(index, type, value, allowed, prefix) {
    for (const key of Object.keys(value)) if (allowed.indexOf(key) === -1) {
      if (key === 'obfuscation' && prefix === 'data') omissions.obfuscation++;
      else save(index, type, prefix + '.' + key, value[key]);
    }
  }
  function members(index, type, partial, target, prefix, skeleton) {
    if (!object(partial) || !object(target)) { save(index,type,prefix,partial); return; }
    for (const key of Object.keys(partial)) {
      const value = partial[key];
      if (Object.prototype.hasOwnProperty.call(target,key) && same(value,target[key])) continue;
      const transition = key === 'status' && ['queued','in_progress'].indexOf(value) !== -1 && target.status === 'completed';
      const initial = skeleton && ((key === 'output' || key === 'content' || key === 'summary') && Array.isArray(value) && value.length === 0 || (key === 'input' && target.type === 'custom_tool_call' || key === 'arguments' && target.type === 'function_call' || key === 'text' && ['output_text','summary_text'].indexOf(target.type) !== -1 || key === 'refusal' && target.type === 'refusal') && value === '');
      const lifecycle = prefix === 'data.response' && (key === 'usage' || key === 'completed_at' || key === 'incomplete_details') && value === null;
      if (transition || initial || lifecycle) omissions.lifecycle++;
      else save(index,type,prefix + '.' + key,value);
    }
  }
  function visibleItem(partial, target, skeleton) {
    if (!object(partial) || !object(target)) return false;
    const key = partial.type === 'function_call' ? 'arguments' : partial.type === 'custom_tool_call' ? 'input' : partial.type === 'refusal' ? 'refusal' : ['output_text','summary_text'].indexOf(partial.type) !== -1 ? 'text' : null;
    if (key && partial[key] !== undefined && !(skeleton && partial[key] === '') && partial[key] !== target[key]) return false;
    for (const name of ['content','summary']) if (Array.isArray(partial[name])) {
      if (!Array.isArray(target[name]) || partial[name].length > target[name].length) return false;
      for (let i = 0; i < partial[name].length; i++) if (!visibleItem(partial[name][i],target[name][i],skeleton)) return false;
    }
    return true;
  }
  const base = ['type','sequence_number'];
  function itemFor(data) {
    if (!Number.isInteger(data.output_index) || data.output_index < 0) return null;
    const item = final.output[data.output_index];
    if (!object(item) || (data.item_id !== undefined && data.item_id !== item.id)) return null;
    return item;
  }
  function stringTarget(type, data) {
    const item = itemFor(data); if (!item) return null;
    if (type.indexOf('response.function_call_arguments.') === 0) return item.type === 'function_call' && typeof item.arguments === 'string' ? [String(data.output_index) + ':arguments', item.arguments, 'arguments'] : null;
    if (type.indexOf('response.custom_tool_call_input.') === 0) return item.type === 'custom_tool_call' && typeof item.input === 'string' ? [String(data.output_index) + ':input', item.input, 'input'] : null;
    const summary = type.indexOf('response.reasoning_summary_text.') === 0;
    const position = summary ? data.summary_index : data.content_index;
    const parts = summary ? item.summary : item.content;
    if (!Number.isInteger(position) || position < 0 || !Array.isArray(parts) || !object(parts[position])) return null;
    const part = parts[position], property = type.indexOf('response.refusal.') === 0 ? 'refusal' : 'text';
    const expectedType = summary ? 'summary_text' : property === 'text' ? 'output_text' : 'refusal';
    if (part.type !== expectedType || typeof part[property] !== 'string') return null;
    return [data.output_index + ':' + (summary ? 'summary' : 'content') + ':' + position + ':' + property, part[property], property];
  }
  const stringFamilies = ['response.output_text.', 'response.refusal.', 'response.function_call_arguments.', 'response.custom_tool_call_input.', 'response.reasoning_summary_text.'];
  for (let index = 0; index < events.length; index++) {
    const event = events[index], type = eventType(event), data = object(event) ? event.data : null;
    if (type === 'error' || /^response\.(failed|incomplete|cancelled|error)$/.test(type) || (object(event) && (event.event === 'error' || /^response\.(failed|incomplete|cancelled|error)$/.test(event.event || '')))) return retain('interrupted_or_error');
    if (!type) continue;
    if (type.endsWith('.delta') && !stringFamilies.some(family => type === family + 'delta')) return retain('unknown_content_delta');
    const knownType = ['response.completed','response.created','response.in_progress','response.output_item.added','response.output_item.done','response.content_part.added','response.content_part.done','response.reasoning_summary_part.added','response.reasoning_summary_part.done'].indexOf(type) !== -1 || stringFamilies.some(family => type === family + 'delta' || type === family + 'done');
    if (knownType) extras(index,type,event,['event','data'],'event');
    if (type === 'response.completed') {
      extras(index,type,data,base.concat(['response']),'data'); removable.add(index);
      continue;
    }
    if (type === 'response.created' || type === 'response.in_progress') {
      if (index > terminalIndex) return retain('events_after_final');
      if (!object(data.response)) return retain('lifecycle_coverage_unproven');
      members(index,type,data.response,final,'data.response',true);
      extras(index,type,data,base.concat(['response']),'data'); removable.add(index);
      continue;
    }
    if (stringFamilies.some(family => type === family + 'delta' || type === family + 'done')) {
      if (index > terminalIndex) return retain('events_after_final');
      const target = stringTarget(type, data);
      if (!target) return retain('visible_coverage_unproven');
      const delta = type.endsWith('.delta'), property = delta ? 'delta' : target[2];
      // Unknown auxiliary fields keep their event even when visible content is covered.
      extras(index,type,data,base.concat(['output_index','item_id','content_index','summary_index',property]),'data');
      if (typeof data[property] !== 'string') return retain('visible_coverage_unproven');
      if (delta) {
        const previous = deltas.get(target[0]);
        deltas.set(target[0], { value: (previous ? previous.value : '') + data.delta, final: target[1] });
      } else if (data[property] !== target[1]) return retain('visible_coverage_mismatch');
      removable.add(index);
      continue;
    }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      if (index > terminalIndex) return retain('events_after_final');
      const item = itemFor(data);
      if (!item || !object(data.item) || data.item.id !== item.id || data.item.type !== item.type || !visibleItem(data.item,item,type.endsWith('.added'))) return retain('item_coverage_unproven');
      members(index,type,data.item,item,'data.item',type.endsWith('.added'));
      extras(index,type,data,base.concat(['output_index','item']),'data'); removable.add(index);
      continue;
    }
    if (['response.content_part.added','response.content_part.done','response.reasoning_summary_part.added','response.reasoning_summary_part.done'].indexOf(type) !== -1) {
      if (index > terminalIndex) return retain('events_after_final');
      const item = itemFor(data), summary = type.indexOf('response.reasoning_summary_part.') === 0;
      const position = summary ? data.summary_index : data.content_index;
      const parts = item && (summary ? item.summary : item.content);
      if (!Number.isInteger(position) || position < 0 || !Array.isArray(parts) || !object(data.part) || !object(parts[position]) || data.part.type !== parts[position].type || !visibleItem(data.part,parts[position],type.endsWith('.added'))) return retain('part_coverage_unproven');
      members(index,type,data.part,parts[position],'data.part',type.endsWith('.added'));
      extras(index,type,data,base.concat(['output_index','item_id',summary ? 'summary_index' : 'content_index','part']),'data'); removable.add(index);
    }
  }
  for (const value of deltas.values()) if (value.value !== value.final) return retain('visible_coverage_mismatch');
  // Preserve output-only tools/parameters/unknown fields in the complete final response.
  response.body = final;
  response.events = events.filter((event, index) => !removable.has(index));
  result.mode = 'final_snapshot'; result.origin = 'response.completed'; result.reason = 'verified_final_coverage';
  result.omitted_events = removable.size;
  result.omitted_event_json_bytes = events.reduce((bytes, event, index) => bytes + (removable.has(index) ? utf8Length(JSON.stringify(event)) : 0), 0);
  result.retained_events = response.events.length;
  return result;
}
export function normalizeReport(ctx, record) {
  const stripped = stripEncrypted(record);
  const residue = [], omissions = { lifecycle: 0, obfuscation: 0 };
  const response = finalEvents(ctx, stripped.report, residue, omissions);
  if (response.mode !== 'final_snapshot') { residue.length = 0; omissions.lifecycle = 0; omissions.obfuscation = 0; }
  return { report: stripped.report, capture: {
    profile: 'readable-v1', original_report_bytes: stripped.originalBytes,
    encrypted_content: { removed_fields: stripped.fields, removed_value_json_bytes: stripped.removedBytes }, response, lifecycle_residue: residue, lifecycle_omissions: omissions,
  } };
}
export function createEnvelope(ctx, record, uploadId) {
  const context = {};
  for (const key of ['format', 'path', 'model', 'upstreamModel', 'group', 'channel', 'attempt', 'instance']) if (ctx[key] !== undefined) context[key] = ctx[key];
  const normalized = normalizeReport(ctx, record);
  return { version: 1, upload_id: uploadId, source: ctx.config.source, context, capture: normalized.capture, report: normalized.report };
}
// flat-json-v1: post-order, nonoverlapping selected spans, independent of paths/UUID offsets.
export function partitionEnvelope(envelope) {
  const tokens = [], spans = [], prioritySpans = []; let position = 0, nodes = 0;
  function push(value) { tokens.push(value); position += value.length; return utf8Length(value); }
  function visit(value, depth, element, priority) {
    if (++nodes > 250000 || depth > 96) throw new Error('contextledger_profile_budget');
    const start = position, spanStart = spans.length; let bytes = 0;
    if (value === null || typeof value !== 'object') bytes = push(JSON.stringify(value));
    else {
      const array = Array.isArray(value); bytes += push(array ? '[' : '{'); let n = 0;
      for (const key of Object.keys(value)) {
        if (n++) bytes += push(',');
        if (!array) bytes += push(JSON.stringify(key) + ':');
        const high = priority || depth === 0 && key === 'capture' || depth === 1 && key === 'response' && value === envelope.report;
        const begin = position;
        bytes += visit(value[key], depth + 1, array, high);
        if (high && !priority) prioritySpans.push([begin,position]);
      }
      bytes += push(array ? ']' : '}');
    }
    if (spans.length === spanStart && bytes >= (element ? 256 : 1024)) spans.push([start, position, priority]);
    return bytes;
  }
  const envelopeBytes = visit(envelope,0,false,false);
  if (envelopeBytes > 32 * 1024 * 1024) throw new Error('contextledger_profile_budget');
  const serialized = tokens.join(''), recipe = [], refs = [], objects = [], indices = new Map(), priorities = new Set();
  function reference(data, priority) {
    const hash = utils.sha256(data), bytes = utf8Length(data);
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('contextledger_hash_unavailable');
    let index = indices.get(hash);
    if (index === undefined) {
      index = refs.length; indices.set(hash,index); refs.push([hash,bytes]); objects.push({hash,data,bytes});
      if (refs.length > 8192) throw new Error('contextledger_manifest_budget');
    }
    if (priority) priorities.add(index);
    recipe.push(['r',hash,bytes]);
  }
  function split(text, selected, priority, offset) {
    if (!selected && utf8Length(text) < 1024) { if (text) recipe.push(['l',text]); return; }
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length,start + 16384);
      if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
      const high = priority || prioritySpans.some(range => range[0] < offset + end && range[1] > offset + start);
      reference(text.slice(start,end),high); start = end;
    }
  }
  let end = 0;
  for (const span of spans) { split(serialized.slice(end,span[0]),false,false,end); split(serialized.slice(span[0],span[1]),true,span[2],span[0]); end = span[1]; }
  split(serialized.slice(end),false,false,end);
  if (recipe.length > 16384) throw new Error('contextledger_manifest_budget');
  const label = value => typeof value === 'string' ? value.slice(0,256) : '';
  const manifest = { wire_version:2,op:'manifest',source:envelope.source,upload_id:envelope.upload_id,envelope_hash:utils.sha256(serialized),envelope_bytes:envelopeBytes,recipe,priority:Array.from(priorities),hint:{request_id:label(envelope.report.requestId),context:{format:label(envelope.context.format),model:label(envelope.context.model)}} };
  const manifestBody = JSON.stringify(manifest);
  if (utf8Length(manifestBody) > 1048576) throw new Error('contextledger_manifest_budget');
  return { envelope, serialized, manifest, manifestBody, objects, refs };
}
export function createTransfer(ctx, record, uploadId) { return partitionEnvelope(createEnvelope(ctx,record,uploadId)); }
export function report(ctx, record) {
  if (ctx.format === 'embedding') return;
  const transfer = createTransfer(ctx,record,utils.uuid()); let body = transfer.manifestBody;
  for (let call = 0; call < 4; call++) {
    const result = utils.fetch({url:ctx.config.url,method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer ' + ctx.config.token},body});
    if (result.status !== 200 && result.status !== 202) throw new Error('contextledger_upload_failed');
    const state = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
    if (!object(state) || state.wire_version !== 2 || state.upload_id !== transfer.manifest.upload_id) throw new Error('contextledger_invalid_ack');
    if (state.state === 'complete') {
      if (result.status !== 200 || state.envelope_hash !== transfer.manifest.envelope_hash || state.missing_count !== 0) throw new Error('contextledger_invalid_ack');
      return;
    }
    if (result.status !== 202 || state.state !== 'partial' || !Array.isArray(state.missing) || state.missing.length === 0 || !Number.isInteger(state.missing_count) || state.missing_count < state.missing.length) throw new Error('contextledger_invalid_ack');
    if (call === 3) return; // Explicit server partial remains visible; never claim complete.
    const prefix = JSON.stringify({wire_version:2,op:'objects',source:transfer.manifest.source,upload_id:transfer.manifest.upload_id}).slice(0,-1) + ',"objects":[';
    const elements = []; let size = utf8Length(prefix) + 2; const seen = new Set();
    for (const index of state.missing) {
      if (!Number.isInteger(index) || index < 0 || index >= transfer.objects.length || seen.has(index)) throw new Error('contextledger_invalid_ack');
      seen.add(index); const item = transfer.objects[index];
      const element = JSON.stringify({hash:item.hash,data:item.data}), elementBytes = utf8Length(element);
      if (elementBytes > 131072) throw new Error('contextledger_object_budget');
      const next = size + elementBytes + (elements.length ? 1 : 0);
      if (next > 1048576) break;
      elements.push(element); size = next;
    }
    if (!elements.length) throw new Error('contextledger_object_budget');
    body = prefix + elements.join(',') + ']}';
    if (utf8Length(body) > 1048576) throw new Error('contextledger_object_budget');
  }
}

'use strict';

/**
 * lib/libsql-http.js — بديل خفيف لـ @libsql/client عبر HTTP الخام (fetch) لواجهة Turso /v2/pipeline.
 * السبب: @libsql/client يحمل ثنائيات native وُضِع في external_node_modules لكن Netlify لم يشحنه
 * مع الدوال المُجمّعة (esbuild) — ففشل التشغيل بـ Cannot find module '@libsql/client'.
 * هذا الشيم بجافاسكربت صِرف يُجمَّع داخل حزمة الدالة ولا يحتاج node_modules وقت التشغيل.
 * يغطي فقط ما يستخدمه lib/db.js: createClient / execute / batch('write') ووسائط blob.
 */

function toCell(v) {
  if (v === null || v === undefined) return { type: 'null', value: null };
  if (typeof v === 'number') {
    // واجهة Turso: integer يقبل نصًا، أما float فيتطلب رقمًا JSON خامًا
    return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  }
  if (typeof v === 'bigint') return { type: 'integer', value: String(v) };
  if (typeof v === 'string') return { type: 'text', value: v };
  if (v instanceof Uint8Array || ArrayBuffer.isView(v)) {
    return { type: 'blob', base64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
  }
  if (v instanceof ArrayBuffer) return { type: 'blob', base64: Buffer.from(v).toString('base64') };
  throw new Error('libsql-http: نوع وسيط غير مدعوم: ' + typeof v);
}

function fromCell(c) {
  if (!c || typeof c !== 'object') return c;
  switch (c.type) {
    case 'null': return null;
    case 'integer': return Number(c.value);
    case 'float': return Number(c.value);
    case 'text': return String(c.value);
    case 'blob':
      return c.base64 ? new Uint8Array(Buffer.from(c.base64, 'base64')) : new Uint8Array(0);
    default: return c.value;
  }
}

class HttpDb {
  constructor({ url, authToken }) {
    if (!url) throw new Error('libsql-http: url مطلوب');
    this.url = url.replace(/\/+$/, '');
    this.authToken = authToken;
  }

  async _pipeline(statements) {
    const res = await fetch(`${this.url}/v2/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: statements.map((s) => ({
          type: 'execute',
          stmt: {
            sql: s.sql,
            args: (s.args || []).map(toCell),
          },
        })),
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`libsql-http: HTTP ${res.status} — ${t.slice(0, 300)}`);
    }
    const body = await res.json();
    const results = body.results || [];
    for (const r of results) {
      if (r.type === 'error' && r.error) {
        throw new Error(`libsql-http: ${r.error.message || 'خطأ قاعدة بيانات'}`);
      }
    }
    return results.map((r) => {
      const result = (r.response && r.response.result) || {};
      const cols = (result.cols || []).map((c) => c.name);
      const rows = (result.rows || []).map((tab) => {
        // صيغة الاستجابة: صف مصفوفة خام، أو كائن {type:'tab', data:[...]} احتياطًا
        const data = Array.isArray(tab) ? tab : (tab && tab.data) || [];
        const obj = {};
        cols.forEach((name, i) => { obj[name] = fromCell(data[i]); });
        return obj;
      });
      return {
        rows,
        columns: cols,
        rowsAffected: result.affected_row_count || 0,
        lastInsertRowid: result.last_insert_rowid ? Number(result.last_insert_rowid) : undefined,
      };
    });
  }

  async execute(sqlOrObj, maybeArgs) {
    const stmt = typeof sqlOrObj === 'string' ? { sql: sqlOrObj, args: maybeArgs || [] } : sqlOrObj;
    const [rs] = await this._pipeline([stmt]);
    return rs;
  }

  async batch(stmts) {
    const rss = await this._pipeline(stmts);
    return rss;
  }
}

/** نفس واجهة createClient في @libsql/client — يحوّل libsql:// إلى https:// */
function createClient(opts) {
  const url = opts.url || '';
  const httpUrl = url.startsWith('libsql://') ? 'https://' + url.slice('libsql://'.length) : url;
  return new HttpDb({ url: httpUrl, authToken: opts.authToken });
}

module.exports = { createClient, HttpDb };

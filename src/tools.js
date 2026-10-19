// Built-in tools for agents. Each tool: {name, label, description, icon,
// run(args, ctx)} where ctx = {fetch, agent, env}. Tools are executed
// server-side; the chat loop decides when to call them (see worker.js).

function num(x, fallback = NaN) {
  const n = Number(String(x).replace(/,/g, ""));
  return Number.isFinite(n) ? n : fallback;
}

export const BUILTIN_TOOLS = [
  {
    name: "calculator",
    label: "الآلة الحاسبة",
    icon: "🧮",
    description: "يحسب تعبيراً رياضياً. الوسائط: {expression} مثال: (1200*0.15)+45",
    async run(args) {
      const expr = String(args.expression || "").trim();
      if (!expr) throw new Error("missing expression");
      if (!/^[0-9+\-*/().,%\s^]+$/.test(expr)) {
        throw new Error("التعبير يحتوي رموزاً غير مسموحة");
      }
      const safe = expr.replace(/\^/g, "**").replace(/%/g, "/100");
      let value;
      try {
        // eslint-disable-next-line no-new-func
        value = Function(`"use strict"; return (${safe});`)();
      } catch {
        throw new Error("تعذّر حساب التعبير");
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("النتيجة ليست رقماً صالحاً");
      }
      return { expression: expr, result: Math.round(value * 1e10) / 1e10 };
    },
  },
  {
    name: "datetime",
    label: "التاريخ والوقت",
    icon: "🕒",
    description: "يعيد التاريخ والوقت الحاليين. الوسائط: {timezone} اختياري، مثال: Africa/Casablanca",
    async run(args) {
      const tz = String(args.timezone || "UTC");
      try {
        const now = new Date();
        return {
          iso: now.toISOString(),
          local: new Intl.DateTimeFormat("ar", {
            dateStyle: "full", timeStyle: "short", timeZone: tz,
          }).format(now),
          timezone: tz,
        };
      } catch {
        throw new Error("منطقة زمنية غير صالحة");
      }
    },
  },
  {
    name: "currency",
    label: "تحويل العملات",
    icon: "💱",
    description: "يحوّل مبلغاً بين العملات بأسعار صرف حديثة. الوسائط: {amount, from, to} مثال: {amount:100, from:USD, to:MAD}",
    async run(args, ctx) {
      const amount = num(args.amount);
      const from = String(args.from || "USD").toUpperCase();
      const to = String(args.to || "MAD").toUpperCase();
      if (!Number.isFinite(amount)) throw new Error("amount غير صالح");
      const res = await ctx.fetch(`https://open.er-api.com/v6/latest/${from}`);
      if (!res.ok) throw new Error("تعذّر جلب أسعار الصرف");
      const data = await res.json();
      const rate = data?.rates?.[to];
      if (!rate) throw new Error("عملة غير مدعومة");
      return {
        amount, from, to, rate,
        result: Math.round(amount * rate * 100) / 100,
        date: data.time_last_update_utc || "",
      };
    },
  },
  {
    name: "url_fetch",
    label: "جلب محتوى رابط",
    icon: "🔗",
    description: "يجلب نص صفحة ويب (يُزال HTML). الوسائط: {url}",
    async run(args, ctx) {
      const url = String(args.url || "").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error("رابط غير صالح");
      // Wikipedia: use the API extracts endpoint (article HTML is often
      // blocked for cloud IPs, while the API works reliably)
      const wm = url.match(/^https:\/\/([a-z-]{2,12})\.wikipedia\.org\/wiki\/([^?#]+)$/);
      if (wm) {
        try {
          const api = `https://${wm[1]}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext&exchars=5000&titles=${wm[2]}&format=json&origin=*`;
          const r = await ctx.fetch(api, {
            headers: { "user-agent": "AI-Agent-Studio/2.0" },
            signal: AbortSignal.timeout(12000),
          });
          if (r.ok) {
            const d = await r.json().catch(() => ({}));
            const pages = d?.query?.pages || {};
            const first = Object.values(pages)[0] || {};
            const text = String(first.extract || "").replace(/\s+/g, " ").trim().slice(0, 6000);
            if (text.length > 200) return { url, text, via: "wikipedia-api" };
          }
        } catch { /* fall through to HTML fetch */ }
      }
      const res = await ctx.fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`فشل الجلب: HTTP ${res.status}`);
      const html = await res.text();
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 6000);
      return { url, text };
    },
  },
  {
    name: "webhook",
    label: "استدعاء API خارجي",
    icon: "📡",
    description: "يرسل طلب HTTP إلى API يعرّفه المستخدم (أداة مخصصة). الوسائط: {tool_id, method, path, body}",
    async run(args, ctx) {
      const tool = await ctx.getCustomTool(String(args.tool_id || ""));
      if (!tool) throw new Error("أداة مخصصة غير موجودة");
      const method = String(args.method || tool.method || "GET").toUpperCase();
      const url = tool.baseUrl.replace(/\/$/, "") + "/" + String(args.path || "").replace(/^\//, "");
      const init = { method, headers: { "content-type": "application/json", ...(tool.headers || {}) } };
      if (method !== "GET" && args.body !== undefined) init.body = JSON.stringify(args.body);
      const res = await ctx.fetch(url, init);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text.slice(0, 4000); }
      return { status: res.status, data };
    },
  },
  {
    name: "reminder",
    label: "تذكير/مهمة",
    icon: "⏰",
    description: "يحفظ تذكيراً أو مهمة للوكيل. الوسائط: {text, when, dueAt} — مثال: {text: \"مراجعة الأسعار\", when: \"غداً 9 صباحاً\", dueAt: \"2026-10-20T09:00:00\"} (dueAt بصيغة ISO اختياري لتنبيه الهاتف)",
    async run(args, ctx) {
      const text = String(args.text || "").trim();
      if (!text) throw new Error("نص التذكير مطلوب");
      const dueAt = String(args.dueAt || "").trim();
      let dueISO = "";
      if (dueAt) {
        const d = new Date(dueAt);
        if (!isNaN(d.getTime())) dueISO = d.toISOString();
      }
      const item = {
        id: "rm_" + Date.now().toString(36),
        text,
        when: String(args.when || ""),
        dueAt: dueISO,
        createdAt: new Date().toISOString(),
        done: false,
      };
      await ctx.addReminder(ctx.agent.id, item);
      return { saved: true, reminder: item };
    },
  },
  {
    name: "web_search",
    label: "بحث الويب الحي",
    icon: "🔍",
    description: "يبحث في الويب الحي عن معلومات حديثة (أسعار، أخبار، وقائع) عبر مصادر متعددة. الوسائط: {query} مثال: {query: \"سعر الذهب اليوم\"}",
    async run(args, ctx) {
      const q = String(args.query || "").trim().slice(0, 200);
      if (!q) throw new Error("query مطلوب");
      const F = ctx.fetch;
      const UA = "AI-Agent-Studio/2.0";
      const withTimeout = (ms) => ({ headers: { "user-agent": UA }, signal: AbortSignal.timeout(ms) });
      const clean = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/&[^;]+;/g, " ").trim().slice(0, 220);

      // Source 1: Brave Search API (optional upgrade — set BRAVE_API_KEY)
      async function brave() {
        const key = ctx.env?.BRAVE_API_KEY;
        if (!key) return [];
        const r = await F("https://api.search.brave.com/res/v1/web/search?q=" + encodeURIComponent(q) + "&count=8",
          { headers: { "X-Subscription-Token": key, "user-agent": UA }, signal: AbortSignal.timeout(9000) });
        if (!r.ok) return [];
        const d = await r.json().catch(() => ({}));
        return (d?.web?.results || []).slice(0, 8).map((x) => ({
          title: String(x.title || "").slice(0, 140), url: x.url,
          snippet: clean(x.description), source: "brave",
        }));
      }
      // Source 2: Wikipedia (ar + en) — reliable encyclopedic coverage
      async function wiki(lang) {
        const r = await F(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=` +
          encodeURIComponent(q) + "&format=json&srlimit=5&origin=*", withTimeout(8000));
        if (!r.ok) return [];
        const d = await r.json().catch(() => ({}));
        return (d?.query?.search || []).map((s) => ({
          title: s.title,
          url: `https://${lang}.wikipedia.org/wiki/` + encodeURIComponent(String(s.title).replace(/ /g, "_")),
          snippet: clean(s.snippet), source: "wikipedia-" + lang,
        }));
      }
      // Source 3: Hacker News (Algolia) — tech & startup pulse
      async function hn() {
        const r = await F("https://hn.algolia.com/api/v1/search?query=" + encodeURIComponent(q) + "&hitsPerPage=5&tags=story", withTimeout(8000));
        if (!r.ok) return [];
        const d = await r.json().catch(() => ({}));
        return (d?.hits || []).filter((h) => h.title).map((h) => ({
          title: String(h.title).slice(0, 140),
          url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
          snippet: clean(`${h.points || 0} نقطة — ${h.num_comments || 0} تعليق`),
          source: "hackernews",
        }));
      }
      // Source 4: StackExchange — programming Q&A
      async function se() {
        const r = await F("https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=" +
          encodeURIComponent(q) + "&site=stackoverflow&pagesize=5&filter=!nNPvSNdWme", withTimeout(8000));
        if (!r.ok) return [];
        const d = await r.json().catch(() => ({}));
        return (d?.items || []).map((it) => ({
          title: clean(it.title).slice(0, 140),
          url: it.link,
          snippet: clean(`إجابات: ${it.answer_count ?? "?"} — ${it.is_answered ? "محلول ✅" : "مفتوح"}`),
          source: "stackoverflow",
        }));
      }
      // Source 5: DuckDuckGo HTML — best effort (often bot-blocked from cloud IPs)
      async function ddg() {
        try {
          const r = await F("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), {
            headers: { "user-agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36" },
            signal: AbortSignal.timeout(9000),
          });
          if (!r.ok) return [];
          const html = await r.text();
          const out = [];
          const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
          let m;
          while ((m = re.exec(html)) && out.length < 6) {
            let href = m[1];
            const ud = href.match(/[?&]uddg=([^&]+)/);
            if (ud) { try { href = decodeURIComponent(ud[1]); } catch { /* keep */ } }
            if (/^https?:\/\//i.test(href)) {
              out.push({ title: clean(m[2]).slice(0, 140), url: href, snippet: "", source: "duckduckgo" });
            }
          }
          return out;
        } catch { return []; }
      }

      // Fan out in parallel; every source is optional
      const settled = await Promise.allSettled([brave(), wiki("ar"), wiki("en"), hn(), se(), ddg()]);
      const seen = new Set();
      const results = [];
      for (const s of settled) {
        if (s.status !== "fulfilled") continue;
        for (const r of s.value) {
          if (!r.url) continue;
          const key = String(r.url).split("?")[0].toLowerCase().replace(/\/$/, "");
          if (seen.has(key) || !r.title) continue;
          seen.add(key);
          results.push(r);
          if (results.length >= 10) break;
        }
        if (results.length >= 10) break;
      }
      const engines = [...new Set(results.map((r) => r.source))];
      return { query: q, results, engines, count: results.length };
    },
  },
  {
    name: "image_generate",
    label: "توليد صورة",
    icon: "🎨",
    description: "يولّد صورة حقيقية من وصف نصي (نموذج FLUX). الوسائط: {prompt} — صف الصورة بالإنجليزية لأفضل نتيجة، مثال: {prompt: \"a cozy bakery at sunrise, warm light\"}",
    async run(args, ctx) {
      const prompt = String(args.prompt || "").trim();
      if (!prompt) throw new Error("وصف الصورة (prompt) مطلوب");
      if (!ctx.generateImage) throw new Error("توليد الصور غير متاح في هذا السياق");
      const r = await ctx.generateImage(prompt);
      const ev = r.evaluation;
      const score = ev && ev.evaluated ? ` — التقييم الذاتي: ${ev.overall}/5` : "";
      return { id: r.id, url: r.url, evaluation: ev || null, note: `تم توليد الصورة وحفظها${score} — أخبر المستخدم أنها جاهزة بالأسفل` };
    },
  },
];

export function getBuiltinTool(name) {
  return BUILTIN_TOOLS.find((t) => t.name === name);
}

export function builtinToolCards() {
  return BUILTIN_TOOLS.map((t) => ({
    id: "builtin:" + t.name,
    name: t.name,
    label: t.label,
    icon: t.icon,
    description: t.description,
    kind: "builtin",
  }));
}

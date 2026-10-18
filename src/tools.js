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
      const res = await ctx.fetch(url, {
        headers: { "user-agent": "AI-Agent-Studio/1.0" },
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
    description: "يحفظ تذكيراً أو مهمة للوكيل. الوسائط: {text, when} مثال: {text: \"مراجعة الأسعار\", when: \"غداً صباحاً\"}",
    async run(args, ctx) {
      const text = String(args.text || "").trim();
      if (!text) throw new Error("نص التذكير مطلوب");
      const item = {
        id: "rm_" + Date.now().toString(36),
        text,
        when: String(args.when || ""),
        createdAt: new Date().toISOString(),
        done: false,
      };
      await ctx.addReminder(ctx.agent.id, item);
      return { saved: true, reminder: item };
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
      const { id, url } = await ctx.generateImage(prompt);
      return { id, url, note: "تم توليد الصورة وحفظها — أخبر المستخدم أنها جاهزة بالأسفل" };
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

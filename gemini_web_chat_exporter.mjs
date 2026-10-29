#!/usr/bin/env node
/**
 * gemini_web_chat_exporter.mjs — Gemini 网页端对话只读导出内核（零依赖，Node >= 22）
 *
 * 安全红线（任何分支都不许突破）：
 *   1. 严禁 Runtime.evaluate / Runtime.callFunctionOn / 任何 JS 注入；
 *   2. 严禁对自动化任务专属标签页（botTargetId）或用户现有标签页发送任何输入事件、激活窗口或修改窗口尺寸；
 *      仅允许在导出器自己创建的后台临时窗口（严格校验 targetId === createdId && targetId !== botTargetId）
 *      内发送一次展开/收起侧边栏点击；
 *   3. 严禁触碰左侧历史会话栏、读取 Cookie / Storage / Profile；
 *   4. 严禁截图、PDF、无障碍树；只做 DOM / Target 域的只读读取。
 *
 * 子命令：
 *   node gemini_web_chat_exporter.mjs list-targets [--state-dir <dir>]
 *   node gemini_web_chat_exporter.mjs export-cdp  --port <p> --target <targetId> [--is-bot] [--detailed] --out-json <path>
 *   node gemini_web_chat_exporter.mjs export-html --file <htmlPath> [--detailed] --out-json <path>
 *   node gemini_web_chat_exporter.mjs export-url  --url <geminiUrl> [--port <p>] [--detailed] --out-json <path>
 *   node gemini_web_chat_exporter.mjs --selftest
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------- 常量
const EXPORTER_DIR = path.dirname(fileURLToPath(import.meta.url));
const NOTEBOOKS_PATH = path.join(EXPORTER_DIR, "saved_notebooks.json");
const SIDEBAR_CACHE_PATH = path.join(EXPORTER_DIR, "sidebar_cache.json");
const DEFAULT_STATE_DIR = process.env.GEMINI_EXPORTER_STATE_DIR || path.join(os.homedir(), ".gemini", "exporter_state");
const PORT_MIN = 29222;
const PORT_MAX = 29299;

const STABLE_SAMPLES = 3;      // 连续三次稳定快照
const STABLE_GAP_MS = 250;     // 采样间隔
const BUSY_MAX_WAIT_MS = 45000;
const BUSY_STALE_MS = 15000;
const BUSY_POLL_MS = 500;

const SIDEBAR_TTL_MS = 5 * 60 * 1000;   // 侧边栏扫描结果缓存 5 分钟（扫描本身要开一次宽屏临时窗口，约 15 秒）
const SIDEBAR_RECENT_LIMIT = 5;
const SIDEBAR_WINDOW = { width: 1440, height: 900 };
const SIDEBAR_URL = "https://gemini.google.com/app";

// 首跑预置的笔记本收藏（Gemini 会把笔记本对话从主列表隔离，只能靠直链进）
const NOTEBOOK_SEED = [];   // 默认不带任何预置收藏，用户首次导出后才会创建收藏文件

const END_MARK_RE = /\[\[\s*END\s*\]\]|<<\s*END\s*>>|【\s*END\s*】|«\s*END\s*»/i;
const BODY_START_RE = /【正文开始】|\[正文开始\]/;

const BOT_SELECTORS = "user-query, model-response";
const FALLBACK_SELECTORS = "user-query, message-content";

// ---------------------------------------------------------------- 通用小工具
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJsonSafe(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "")); } catch { return fallback; }
}

function isPidAlive(pid) {
  if (!pid || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function hash32(text) {
  return createHash("md5").update(String(text || ""), "utf8").digest("hex").slice(0, 12);
}

function nowIso() { return new Date().toISOString(); }

/** 诊断信息只走 stderr：stdout 必须保持纯 JSON，给 PowerShell 解析 */
function logQuiet(step, msg) {
  try { process.stderr.write("[" + step + "] " + String(msg || "") + "\n"); } catch {}
}

class ExportError extends Error {}

function fail(msg) { throw new ExportError(msg); }

// ---------------------------------------------------------------- URL / 笔记本收藏
const GEMINI_APP_URL_RE = /^https?:\/\/gemini\.google\.com\/(?:u\/\d+\/)?app(?:\/([0-9a-fA-F]{8,}))?(?:[/?#].*)?$/i;

/** 从 Gemini 会话地址里取 hex 会话 id；支持 /app/<id> 与 /u/0/app/<id> 两种路由 */
function conversationIdFromUrl(url) {
  const s = String(url || "").trim();
  if (!s) return "";
  const m = /\/app\/([0-9a-fA-F]{8,})(?:[/?#]|$)/.exec(s);
  if (m) return m[1].toLowerCase();
  return "";
}

function isGeminiAppUrl(url) {
  return GEMINI_APP_URL_RE.test(String(url || "").trim());
}

function cleanGeminiTitle(title) {
  return String(title || "")
    .replace(/^[\u200e\u200f\u202a-\u202e]+/g, "")
    .replace(/\s*[-–—]\s*Google Gemini\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function loadNotebooks() {
  const raw = readJsonSafe(NOTEBOOKS_PATH, null);
  if (!Array.isArray(raw)) {
    const seeded = NOTEBOOK_SEED.map((x) => ({ ...x }));
    if (!seeded.length) return [];    // 没有预置收藏时保持“无文件”状态，不制造占位文件
    try { fs.writeFileSync(NOTEBOOKS_PATH, JSON.stringify(seeded, null, 2), "utf8"); } catch {}
    return seeded;
  }
  return raw.filter((x) => x && typeof x.url === "string");
}

function saveNotebooks(list) {
  try {
    fs.writeFileSync(NOTEBOOKS_PATH, JSON.stringify(list, null, 2), "utf8");
    return true;
  } catch { return false; }
}

/** 导出成功后把该会话并入收藏（按 hex 会话 id 去重，已有则更新标题与时间） */
function upsertNotebook({ url, title }) {
  const id = conversationIdFromUrl(url);
  if (!id) return null;
  const list = loadNotebooks();
  const now = new Date().toISOString();
  const cleanTitle = cleanGeminiTitle(title) || ("Gemini 对话 " + id);
  const idx = list.findIndex((x) => conversationIdFromUrl(x.url) === id);
  if (idx >= 0) {
    list[idx] = { ...list[idx], url: String(url), title: cleanTitle, last_exported_at: now };
  } else {
    list.unshift({ url: String(url), title: cleanTitle, added_at: now, last_exported_at: now });
  }
  saveNotebooks(list);
  return { list, added: idx < 0, id, title: cleanTitle };
}

// ---------------------------------------------------------------- 侧边栏：置顶 + 最新 N（纯函数部分可单测）
/**
 * 去重 + 分类：置顶全要，近期只要前 N 条；同一条既置顶又近期时只留置顶那份。
 * @param {Array<{id?:string,url?:string,title:string,pinned?:boolean}>} items 文档顺序（置顶在前）
 */
function buildSidebarView(items, opts = {}) {
  const excludeIds = new Set((opts.excludeIds || []).map((x) => String(x).toLowerCase()).filter(Boolean));
  const excludeTitles = new Set((opts.excludeTitles || []).map((x) => String(x).trim()).filter(Boolean));
  const recentLimit = Number.isFinite(opts.recentLimit) ? opts.recentLimit : SIDEBAR_RECENT_LIMIT;
  const seen = new Set();
  const pinned = [];
  const recent = [];

  for (const it of items || []) {
    if (!it || !it.title) continue;
    const id = String(it.id || "").toLowerCase();
    if (id && excludeIds.has(id)) continue;
    if (excludeTitles.has(String(it.title).trim())) continue;
    const key = id || ("t:" + String(it.title).trim());
    if (seen.has(key)) continue;
    seen.add(key);
    const rec = { id: it.id || "", url: it.url || "", title: it.title, pinned: Boolean(it.pinned), category: it.pinned ? "pinned" : "recent" };
    if (it.pinned) pinned.push(rec);
    else recent.push(rec);
  }
  return { pinned, recent: recent.slice(0, recentLimit) };
}

/** 解析一条 gemini-nav-list-item 的 outerHTML */
function parseConversationItem(html) {
  const src = String(html || "");
  if (src.length < 200) return null;                 // 空壳：只有 8 个 <!----> 占位
  const aTag = /<a\b[^>]*>/i.exec(src);
  if (!aTag) return null;
  const href = (/href="([^"]*)"/i.exec(aTag[0]) || [])[1] || "";
  const aria = decodeEntities(((/aria-label="([^"]*)"/i.exec(aTag[0]) || [])[1] || "").trim());
  const titleSpan = (/class="title-text[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(src) || [])[1] || "";
  const title = decodeEntities(String(titleSpan).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() || aria;
  if (!title) return null;
  let id = conversationIdFromUrl(href) || conversationIdFromUrl(aria);
  if (!id) {
    const js = /jslog="([^"]*)"/i.exec(aTag[0]);
    const m = js ? /c_([0-9a-fA-F]{8,})/.exec(js[1] || "") : null;
    if (m) id = m[1].toLowerCase();
  }
  const pinned = /fonticonname="push_pin"/i.test(src) || /aria-label="固定的对话"/.test(src);
  return { id, url: id ? ("https://gemini.google.com/app/" + id) : "", title, pinned };
}

function loadSidebarCache() {
  const c = readJsonSafe(SIDEBAR_CACHE_PATH, null);
  if (!c || !Array.isArray(c.items)) return null;
  return c;
}

function saveSidebarCache(items) {
  try {
    fs.writeFileSync(SIDEBAR_CACHE_PATH, JSON.stringify({ scanned_at: nowIso(), scanned_at_ms: Date.now(), items }, null, 2), "utf8");
  } catch {}
}

// ---------------------------------------------------------------- 参数解析
const BOOL_FLAGS = new Set(["detailed", "is-bot", "help", "h", "selftest", "json", "quiet", "no-sidebar", "refresh", "no-favorite"]);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOL_FLAGS.has(key)) out[key] = true;
      else { out[key] = argv[i + 1]; i++; }
    } else if (a.startsWith("-") && a.length === 2) {
      const key = a.slice(1);
      if (BOOL_FLAGS.has(key)) out[key] = true;
      else { out[key] = argv[i + 1]; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// ================================================================ HTML → 结构化文本
// 7 步顺序：① 保护代码块 → ② 块级边界换行 → ③ 列表/引用/表格 → ④ 剥离思考节点
//            → ⑤ 解码实体 → ⑥ 收敛空行 → ⑦ 逐字段 trim

const NAMED_ENTITIES = {
  nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"",
  apos: "'", hellip: "…", mdash: "—", ndash: "–", middot: "·", laquo: "«", raquo: "»",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", bull: "•", times: "×", divide: "÷",
  copy: "©", reg: "®", trade: "™", rarr: "→", larr: "←", uarr: "↑", darr: "↓", deg: "°",
};

function decodeEntities(input) {
  return String(input || "").replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
      try { return String.fromCodePoint(code); } catch { return ""; }
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : m;
  });
}

function findTagEnd(s, start) {
  if (s[start] !== "<") return -1;
  let quote = null;
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "\"" || c === "'") { quote = c; continue; }
    if (c === ">") return i + 1;
  }
  return -1;
}

/** 从 openStart 处的开标签起，找到配对的闭标签结束位置（返回其后的下标）；找不到返回 -1 */
function findMatchingClose(s, tagName, openStart) {
  const re = new RegExp("<(/?)" + tagName + "(?=[\\s/>])", "gi");
  re.lastIndex = openStart;
  let depth = 0;
  let m;
  while ((m = re.exec(s))) {
    const isClose = m[1] === "/";
    const tagEnd = findTagEnd(s, m.index);
    if (tagEnd < 0) return -1;
    const raw = s.slice(m.index, tagEnd);
    if (/\/>\s*$/.test(raw)) continue;
    if (isClose) { depth -= 1; if (depth === 0) return tagEnd; }
    else depth += 1;
  }
  return -1;
}

/** 删除所有指定标签（配对删除；未闭合时只删开标签本身） */
function removeTagBalanced(html, tagName) {
  let s = String(html || "");
  const openRe = new RegExp("<" + tagName + "(?=[\\s/>])", "i");
  for (let guard = 0; guard < 400; guard++) {
    const m = openRe.exec(s);
    if (!m) return s;
    const end = findMatchingClose(s, tagName, m.index);
    if (end < 0) {
      const gt = findTagEnd(s, m.index);
      if (gt < 0) return s;
      s = s.slice(0, m.index) + " " + s.slice(gt);
      continue;
    }
    s = s.slice(0, m.index) + " " + s.slice(end);
  }
  return s;
}

/**
 * 按「开标签正则」删除元素并可选回收文本；openTagRe 必须匹配一个完整的开标签。
 */
function extractElementsMatching(html, openTagRe, sink = null) {
  let s = String(html || "");
  for (let guard = 0; guard < 400; guard++) {
    openTagRe.lastIndex = 0;
    const m = openTagRe.exec(s);
    if (!m) break;
    const tagName = (/^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(m[0]) || [])[1];
    const end = tagName ? findMatchingClose(s, tagName, m.index) : -1;
    let chunkEnd = end;
    if (chunkEnd < 0) { chunkEnd = findTagEnd(s, m.index); if (chunkEnd < 0) break; }
    if (sink) {
      const text = htmlToStructuredText(s.slice(m.index, chunkEnd), { extractThoughts: false }).text;
      if (text) sink.push(text);
    }
    s = s.slice(0, m.index) + "\n" + s.slice(chunkEnd);
  }
  return s;
}

const NOISE_TAGS = [
  "script", "style", "svg", "button", "mat-icon", "gem-icon", "gem-button",
  "mat-progress-spinner", "copy-button", "sources-carousel", "source-footnote",
  "inline-citation", "thumb-up-button", "thumb-down-button", "response-element-button",
  "refinement-chips", "more-menu",
];
// 无障碍朗读用的重复文本（「你说」「Gemini 说」+ 截断副本）必须剥掉，否则会混进正文
const VISUALLY_HIDDEN_RE = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*class="[^"]*cdk-visually-hidden[^"]*"[^>]*>/gi;

function stripNoise(html) {
  let out = String(html || "");
  for (const t of NOISE_TAGS) out = removeTagBalanced(out, t);
  out = extractElementsMatching(out, new RegExp(VISUALLY_HIDDEN_RE.source, "gi"));
  return out;
}

// 思考节点：标签名 + 属性/类两种来源
const THOUGHT_TAG_RE = /<(model-thoughts|expansion-panel)\b[^>]*>/gi;
const THOUGHT_ATTR_RE = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*(?:data-test-id="[^"]*thought[^"]*"|class="[^"]*thoughts-container[^"]*")[^>]*>/gi;

/** 分离思考节点：返回 { main, thoughts } ，thoughts 为文本数组 */
function splitThoughts(html) {
  const thoughts = [];
  let main = String(html || "");
  main = extractElementsMatching(main, new RegExp(THOUGHT_TAG_RE.source, "gi"), thoughts);
  main = extractElementsMatching(main, new RegExp(THOUGHT_ATTR_RE.source, "gi"), thoughts);
  return { main, thoughts };
}

// 代码占位符：B = 块级（前后加换行），I = 行内（原样嵌回）
const CODE_TOKEN_RE = /\u0001([BI])(\d+)\u0001/g;
const codeToken = (i, inline) => "\u0001" + (inline ? "I" : "B") + i + "\u0001";

/** 步骤①：先定位并保护 <pre> / <code> / <code-block> 内部原文（保留换行/空格/制表/反引号） */
function protectCodeBlocks(html) {
  const stash = [];
  const put = (text, inline = false) => { stash.push(text); return codeToken(stash.length - 1, inline); };
  const codeInner = (inner) => decodeEntities(
    String(inner || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:div|p|li)>/gi, "\n")
      .replace(/<[^>]*>/g, "")            // 仅剥离高亮 span 等标记，保留纯文本
  ).replace(/\r\n?/g, "\n");

  let out = String(html || "");
  out = out.replace(/<code-block\b[^>]*>([\s\S]*?)<\/code-block>/gi, (m, inner) => {
    const pre = inner.match(/<pre\b[^>]*>([\s\S]*?)<\/pre>/i);
    return put(codeInner(pre ? pre[1] : inner));
  });
  out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (m, inner) => put(codeInner(inner)));
  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (m, inner) => put(codeInner(inner), true));
  return { html: out, stash };
}

const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "nav", "aside",
  "figure", "figcaption", "hr", "table", "thead", "tbody", "tfoot", "tr", "ul", "ol",
  "dl", "dt", "dd", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "li", "pre",
  "code-block", "message-content", "model-response", "user-query", "response-element",
  "message-text", "markdown", "chat-window",
]);

function normalizeInline(text) {
  return String(text || "").replace(/[\t\r\n\f\u00a0]+/g, " ").replace(/ {2,}/g, " ");
}

/** 步骤②③：线性分词，块级换行 / 列表前缀 / 引用前缀 / 表格制表符 */
function tokenizeFlow(html) {
  let out = "";
  let atLineStart = true;
  let quoteDepth = 0;

  const push = (t) => {
    if (!t) return;
    if (atLineStart && quoteDepth > 0 && t.trim()) out += "> ".repeat(quoteDepth);
    out += t;
    atLineStart = t.endsWith("\n");
  };
  const brk = () => { if (out && !out.endsWith("\n")) { out += "\n"; atLineStart = true; } };

  const tagRe = /<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const tok = m[0];
    if (tok[0] !== "<") { push(normalizeInline(decodeEntities(tok))); continue; }
    if (tok.startsWith("<!--") || tok.startsWith("<!")) continue;

    if (tok[1] === "/") {
      const name = (/^<\/([a-zA-Z][a-zA-Z0-9-]*)/.exec(tok) || [])[1];
      if (!name) continue;
      const lower = name.toLowerCase();
      if (lower === "blockquote") { brk(); quoteDepth = Math.max(0, quoteDepth - 1); continue; }
      if (BLOCK_TAGS.has(lower)) brk();
      continue;
    }

    const name = (/^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(tok) || [])[1];
    if (!name) continue;
    const lower = name.toLowerCase();
    if (lower === "br") { brk(); continue; }
    if (lower === "img") { push("[图片]"); continue; }
    if (lower === "li") { brk(); push("- "); continue; }
    if (lower === "blockquote") { brk(); quoteDepth += 1; continue; }
    if (lower === "td" || lower === "th") { if (!atLineStart) push("\t"); continue; }
    if (BLOCK_TAGS.has(lower)) brk();
  }
  return out;
}

function cleanupStructure(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/^[ \t]+/gm, "")     // 源 HTML 排版残留的行首空白（代码块此时已被 token 保护，不受影响）
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function restoreCode(text, stash) {
  if (!stash.length) return text;
  const restored = String(text || "").replace(CODE_TOKEN_RE, (m, kind, idx) => {
    const code = stash[Number(idx)];
    if (code == null) return "";
    if (kind === "I") return String(code);                       // 行内代码：原样嵌回，不加换行
    const clean = String(code).replace(/^\n+/, "").replace(/\n+$/, "");
    return "\n" + clean + "\n";                                  // 块级代码：独占若干行
  });
  return restored.replace(/[ \t]+\n/g, "\n");
}

/**
 * 结构化 HTML → 纯净文本（+ 独立思考数组）
 * @returns {{text: string, thoughts: string[]}}
 */
function htmlToStructuredText(html, opts = {}) {
  const { extractThoughts = true } = opts;
  let src = stripNoise(html);
  const thoughts = [];
  if (extractThoughts) {
    const split = splitThoughts(src);
    src = split.main;
    thoughts.push(...split.thoughts);
  }
  const { html: protectedHtml, stash } = protectCodeBlocks(src);
  const flowed = tokenizeFlow(protectedHtml);
  const structured = cleanupStructure(flowed);
  const text = restoreCode(structured, stash).replace(/[ \t]+\n/g, "\n").trim();
  return { text, thoughts };
}

// ---------------------------------------------------------------- 轮次配对
const ENVELOPE_RE = /\[\[\s*END\s*\]\]|<<\s*END\s*>>|【\s*END\s*】|【正文开始】|\[正文开始\]/gi;
const CTRL_TAG_RE = /[\[【](?:QUOTE|STICKER|VOICE|SOCIAL|STICKER_MEMO|JOIN_GROUP|PASS|正文结束)\s*(?:[：:][^\]】]*)?[\]】]/gi;

/**
 * 简洁模式用：剥离信封标签，保留人话。
 * controlTags=false 时只剥「正文开始 / 结束符」这类包裹标记，保留 [PASS] [STICKER:] 等
 * 在提示词里带语义的控制标签（提示词原文不该被改写）。
 */
function stripEnvelope(text, opts = {}) {
  const controlTags = opts.controlTags !== false;
  let out = String(text || "").replace(ENVELOPE_RE, " ");
  if (controlTags) out = out.replace(CTRL_TAG_RE, " ");
  return out
    // 只收敛「行中出现」的多余空格；行首缩进（代码块）必须原样保留
    .replace(/(?<=\S)[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * items: [{kind:"user"|"model", html}]（必须按文档顺序）
 * 规则：user 开启一轮；其后的 model 归属该轮（多版本取最后稳定版本）；无主 model 收进 unpaired。
 */
function buildConversation(items, opts = {}) {
  const detailed = Boolean(opts.detailed);
  const turns = [];
  const unpaired = [];
  let cur = null;
  let consecutiveModels = 0;

  for (const item of items || []) {
    const html = String(item.html || "");
    if (!item.kind || !html) continue;
    if (item.kind === "user") {
      const r = htmlToStructuredText(html, { extractThoughts: false });
      cur = {
        index: turns.length + 1,
        user: r.text,
        // 提示词原文只剥包裹标记，保留 [PASS]/[STICKER:] 等语义标签
        user_clean: stripEnvelope(r.text, { controlTags: false }),
        model: "",
        model_clean: "",
        thoughts: [],
      };
      turns.push(cur);
      consecutiveModels = 0;
      continue;
    }
    const r = htmlToStructuredText(html, { extractThoughts: true });
    const modelText = r.text;
    consecutiveModels += 1;
    // 同一轮内最多两条连续 model-response 视为「同一回复的多版本」，只留最后稳定版本；
    // 第 3 条及以后无法配对，绝不静默丢弃 → 统一归档。
    if (!cur) unpaired.push(modelText);
    else if (consecutiveModels <= 2) {
      cur.model = modelText;
      cur.model_clean = stripEnvelope(modelText);
      cur.thoughts = detailed ? r.thoughts : [];
    }
    else unpaired.push(modelText);
  }

  for (const t of turns) {
    if (!detailed) delete t.thoughts;
    else if (!t.thoughts.length) t.thoughts = [];
  }
  return { turns, unpaired_model_outputs: unpaired };
}

/** 信封格式专用校验收口：有【正文开始】就必须「以结束符收尾」，否则判定流式未完结 */
const END_MARK_TAIL_RE = /(?:\[\[\s*END\s*\]\]|<<\s*END\s*>>|【\s*END\s*】|«\s*END\s*»)\s*$/i;
const BODY_START_LAST_RE = /(?:【正文开始】|\[正文开始\])/g;

function botReplyComplete(conv) {
  const lastTurn = [...conv.turns].reverse().find((t) => t.model);
  const text = lastTurn ? lastTurn.model : (conv.unpaired_model_outputs[conv.unpaired_model_outputs.length - 1] || "");
  if (!text) return { ok: true, reason: "empty_conversation" };
  if (!BODY_START_RE.test(text)) return { ok: true, reason: "no_body_marker" };

  const tail = String(text).trim();
  // 必须「末尾锚定」：历史正文中间出现过的 [[END]] 不能算数
  if (!END_MARK_TAIL_RE.test(tail)) return { ok: false, reason: "streaming_incomplete" };
  const endPos = tail.search(END_MARK_TAIL_RE);
  const starts = [...tail.matchAll(BODY_START_LAST_RE)].map((m) => m.index + m[0].length);
  const bodyStart = starts.length ? starts[starts.length - 1] : 0;
  if (endPos <= bodyStart) return { ok: false, reason: "empty_body" };
  if (!tail.slice(bodyStart, endPos).trim()) return { ok: false, reason: "empty_body" };
  return { ok: true, reason: "complete" };
}

// ---------------------------------------------------------------- HTML 文件里的节点扫描
const NODE_TAG_RE = /<(user-query|model-response)(?=[\s>])/gi;

/** 从整页 HTML 里按文档顺序抓 user-query / model-response（配对栈式，跳过已消费区间） */
function scanConversationNodes(pageHtml) {
  const s = String(pageHtml || "");
  const items = [];
  let cursor = 0;
  NODE_TAG_RE.lastIndex = 0;
  let m;
  while ((m = NODE_TAG_RE.exec(s))) {
    if (m.index < cursor) continue;
    const tag = m[1].toLowerCase();
    const end = findMatchingClose(s, tag, m.index);
    if (end < 0) continue;
    items.push({ kind: tag === "user-query" ? "user" : "model", html: s.slice(m.index, end) });
    cursor = end;
    NODE_TAG_RE.lastIndex = end;
  }
  return items;
}

function readHtmlFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : "";
  let body = raw;
  const bodyOpen = raw.search(/<body\b[^>]*>/i);
  const bodyClose = raw.toLowerCase().lastIndexOf("</body>");
  if (bodyOpen >= 0 && bodyClose > bodyOpen) {
    const start = raw.indexOf(">", bodyOpen) + 1;
    body = raw.slice(start, bodyClose);
  }
  return { html: body, title };
}

// ---------------------------------------------------------------- 忙闲门禁
/**
 * 纯函数：判定 cdp_activity.json 的忙闲状态（可单测）
 * @returns {{state:string, reason:string, [k:string]:any}}
 */
function evaluateActivity(act, opts = {}) {
  const now = opts.now == null ? Date.now() : opts.now;
  const staleMs = opts.staleMs == null ? BUSY_STALE_MS : opts.staleMs;
  const alive = typeof opts.isPidAlive === "function" ? opts.isPidAlive : isPidAlive;

  if (!act || typeof act !== "object" || Array.isArray(act) || !Object.keys(act).length) {
    return { state: "absent", reason: "no_activity_file" };
  }
  if (act.phase === "stopped" && act.busy !== true) {
    return { state: "idle", reason: "phase_stopped", phase: "stopped" };
  }
  if (act.busy !== true) {
    return { state: "idle", reason: "busy_false", phase: act.phase || "", operation_id: act.operation_id || "" };
  }
  const pid = Number(act.pid) || 0;
  const pidOk = alive(pid);
  const ageMs = now - (Number(act.updated_at_ms) || 0);
  const base = { pid, ageMs, phase: act.phase || "", operation_id: act.operation_id || "" };
  if (!pidOk) return { state: "busy_dead", reason: "pid_not_alive", ...base };
  if (!(ageMs <= staleMs)) return { state: "busy_stale", reason: "heartbeat_stale", ...base };
  return { state: "busy_fresh", reason: "busy", ...base };
}

/**
 * 自动化任务的忙闲门禁：等外部协同锁降到 idle；状态异常立即保守放弃。
 */
/**
 * 可选：命令行核验外部协同锁的持有者。
 * 只有设置了 GEMINI_EXPORTER_DAEMON_HINT（进程命令行里应包含的关键字）时才做这项核验，
 * 用来防止 pid 被系统复用后误判成「一直在忙」。未配置时不做判断，直接放行。
 */
const DAEMON_CMD_HINT = process.env.GEMINI_EXPORTER_DAEMON_HINT || "";
const daemonPidCache = new Map();

function isDaemonPid(pid) {
  if (!DAEMON_CMD_HINT) return true;
  const key = Number(pid) || 0;
  if (!key) return false;
  if (daemonPidCache.has(key)) return daemonPidCache.get(key);
  let ok = true;
  try {
    const cmd = "(Get-CimInstance Win32_Process -Filter 'ProcessId=" + key + "').CommandLine";
    const out = execFileSync("powershell", ["-NoProfile", "-Command", cmd], {
      timeout: 6000, encoding: "utf8", windowsHide: true,
    });
    ok = String(out || "").includes(DAEMON_CMD_HINT);
  } catch { ok = true; }
  daemonPidCache.set(key, ok);
  return ok;
}

async function gateBotIdle(stateDir, opts = {}) {
  const maxWaitMs = opts.maxWaitMs == null ? BUSY_MAX_WAIT_MS : opts.maxWaitMs;
  const pollMs = opts.pollMs == null ? BUSY_POLL_MS : opts.pollMs;
  const started = Date.now();
  const activityPath = path.join(stateDir, "cdp_activity.json");
  let waited = 0;

  for (;;) {
    const act = readJsonSafe(activityPath, null);
    const verdict = evaluateActivity(act, { now: Date.now(), staleMs: BUSY_STALE_MS });

    if (verdict.state === "idle") return { ...verdict, source: "cdp_activity", waited_ms: waited };
    if (verdict.state === "busy_fresh") {
      // 轻量核验：pid 可能被系统复用给了别的进程，命令行里没有守护进程名就当空闲
      if (!isDaemonPid(verdict.pid)) {
        return { state: "idle", reason: "pid_reused", pid: verdict.pid, source: "pid_reuse_check", waited_ms: waited };
      }
      if (Date.now() - started >= maxWaitMs) {
        fail("后台自动化任务正在操作网页（" + (verdict.phase || "运行中") + "，pid " + verdict.pid + "），已等待 "
          + Math.round(maxWaitMs / 1000) + " 秒仍忙，为避免打断回合，本次导出保守放弃。请稍后重试。");
      }
      await sleep(pollMs);
      waited = Date.now() - started;
      continue;
    }
    if (verdict.state === "busy_dead") {
      fail("忙闲锁显示自动化任务进程仍在操作页面，但该进程已不存在（pid " + verdict.pid + "）。"
        + "可能是守护进程崩溃在操作中途，页面可能只写了一半。已保守放弃；确认页面正常后可删除 "
        + activityPath + " 再重试。");
    }
    if (verdict.state === "busy_stale") {
      fail("忙闲锁超过 15 秒没有心跳（疑似守护进程卡死或已挂起，pid " + verdict.pid + "，"
        + Math.round(verdict.ageMs / 1000) + " 秒未更新）。已保守放弃；确认后可删除 "
        + activityPath + " 再重试。");
    }

    // absent：旧版守护没有忙闲锁，回退看 runtime_state.json 的写入活跃度
    const runtimePath = path.join(stateDir, "runtime_state.json");
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(runtimePath).mtimeMs; } catch { mtimeMs = 0; }
    let daemonPid = 0;
    try { daemonPid = Number(readJsonSafe(path.join(stateDir, "gemini_web_daemon.lock.json"), null)?.pid) || 0; } catch { daemonPid = 0; }
    const active = mtimeMs > 0 && Date.now() - mtimeMs < 3000 && isPidAlive(daemonPid);
    if (!active) {
      return { state: "absent", reason: "fallback_runtime_state_idle", source: "runtime_state", waited_ms: waited };
    }
    if (Date.now() - started >= maxWaitMs) {
      fail("无忙闲锁，但状态文件 3 秒内仍在被写入（pid " + daemonPid + "），判定后台任务可能正在处理，保守放弃。");
    }
    await sleep(pollMs);
    waited = Date.now() - started;
  }
}

// ---------------------------------------------------------------- CDP 只读客户端
class CdpConn {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(new ExportError("连接 CDP 超时：" + this.wsUrl));
      }, 8000);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new ExportError("连接 CDP 失败：" + this.wsUrl));
      };
      ws.onmessage = (ev) => this._onMessage(ev.data);
      ws.onclose = () => {
        for (const [, h] of this.pending) { try { h.rej(new ExportError("CDP 连接已关闭")); } catch {} }
        this.pending.clear();
      };
    });
    return this;
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || !msg.id) return;
    const h = this.pending.get(msg.id);
    if (!h) return;
    this.pending.delete(msg.id);
    if (msg.error) h.rej(new ExportError(msg.error.message || "cdp_error"));
    else h.res(msg.result);
  }

  send(method, params = {}, sessionId = null, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { res: resolve, rej: reject });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      try { this.ws.send(JSON.stringify(msg)); } catch (e) { this.pending.delete(id); return reject(e); }
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new ExportError("CDP 命令超时：" + method));
        }
      }, timeoutMs);
      // 超时定时器不能把 Node 事件循环吊住：否则命令跑完还要空等 20 秒才退出
      if (timer && typeof timer.unref === "function") timer.unref();
    });
  }

  close() { try { if (this.ws) this.ws.close(); } catch {} }
}

async function fetchJson(url, timeoutMs = 800) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error("http_" + r.status);
  return r.json();
}

const COMMON_DEBUG_PORTS = [9222, 29291, 9229];   // 通用 Chrome 调试端口优先探测

async function discoverPorts() {
  const ports = [];
  for (const p of COMMON_DEBUG_PORTS) if (!ports.includes(p)) ports.push(p);
  for (let p = PORT_MIN; p <= PORT_MAX; p++) if (!ports.includes(p)) ports.push(p);
  const found = [];
  const worker = async (list) => {
    for (const p of list) {
      try {
        const v = await fetchJson("http://127.0.0.1:" + p + "/json/version", 400);
        if (v && String(v.Browser || "").includes("Chrome") && v.webSocketDebuggerUrl) {
          found.push({ port: p, wsUrl: v.webSocketDebuggerUrl, browser: String(v.Browser || "") });
        }
      } catch {}
    }
  };
  const chunks = [];
  for (let i = 0; i < ports.length; i += 20) chunks.push(ports.slice(i, i + 20));
  await Promise.all(chunks.map((c) => worker(c)));
  found.sort((a, b) => a.port - b.port);
  return found;
}

async function attachTarget(conn, targetId) {
  const r = await conn.send("Target.attachToTarget", { targetId, flatten: true }, null, 12000);
  if (!r || !r.sessionId) fail("无法附着标签页：" + targetId);
  return r.sessionId;
}

async function detachTarget(conn, sessionId) {
  if (!sessionId) return;
  try { await conn.send("Target.detachFromTarget", { sessionId }, null, 8000); } catch {}
}

async function targetTitle(conn, targetId) {
  try {
    const r = await conn.send("Target.getTargetInfo", { targetId }, null, 8000);
    return r && r.targetInfo && r.targetInfo.title ? String(r.targetInfo.title) : "";
  } catch { return ""; }
}

/** 在当前标签页里读一遍对话节点（全部命令显式带独立 sessionId） */
async function readNodes(conn, sessionId) {
  const doc = await conn.send("DOM.getDocument", { depth: 2 }, sessionId, 20000);
  const root = doc && doc.root ? doc.root.nodeId : 0;
  if (!root) fail("读取 DOM 根节点失败");

  let nodeIds = [];
  try {
    const r = await conn.send("DOM.querySelectorAll", { nodeId: root, selector: BOT_SELECTORS }, sessionId, 20000);
    nodeIds = (r && r.nodeIds) || [];
  } catch { nodeIds = []; }

  if (!nodeIds.length) {
    try {
      const r = await conn.send("DOM.querySelectorAll", { nodeId: root, selector: FALLBACK_SELECTORS }, sessionId, 20000);
      nodeIds = (r && r.nodeIds) || [];
    } catch { nodeIds = []; }
  }

  const items = [];
  for (const nodeId of nodeIds) {
    let html = "";
    try { html = (await conn.send("DOM.getOuterHTML", { nodeId }, sessionId, 20000)).outerHTML || ""; } catch { continue; }
    const tag = ((/^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.trim()) || [])[1] || "").toLowerCase();
    const kind = tag === "user-query" ? "user" : "model";
    items.push({ kind, html });
  }
  return items;
}

/**
 * 稳定快照指纹：节点数量 + 每个节点的 HTML 字节长度 + 总字节数。
 * 覆盖全部节点（不只末尾一条），任何一条还在流式增长都会让指纹变化。
 */
function signatureOf(items) {
  if (!items.length) return "0|empty";
  // 每个节点都带内容哈希：即使流式前后字节长度巧合相同，内容变化也一定被捕获
  const parts = items.map((it) => it.kind + ":" + String(it.html || "").length + ":" + hash32(it.html));
  const total = items.reduce((a, it) => a + String(it.html || "").length, 0);
  return items.length + "|" + parts.join(",") + "|" + total;
}

/**
 * 连续采样直到稳定。
 * requireNonEmpty=true 时：空页面（0 个对话节点）绝不算「稳定」，必须等到正文真正渲染出来，
 * 之后才开始数「连续 N 次一致」。这是修 0|empty 假稳定的关键。
 * opts.reader 可注入（自检用），默认读真实 DOM。
 */
async function stableRead(conn, sessionId, opts = {}) {
  const need = opts.samples == null ? STABLE_SAMPLES : opts.samples;
  const gapMs = opts.gapMs == null ? STABLE_GAP_MS : opts.gapMs;
  const timeoutMs = opts.timeoutMs == null ? 30000 : opts.timeoutMs;
  const requireNonEmpty = Boolean(opts.requireNonEmpty);
  const reader = typeof opts.reader === "function" ? opts.reader : () => readNodes(conn, sessionId);
  const deadline = Date.now() + timeoutMs;

  let prevSig = null;
  let sameCount = 0;
  let sawEmpty = false;

  for (;;) {
    let items = [];
    let err = null;
    try { items = await reader(); } catch (e) { err = e; }
    if (err) {
      if (Date.now() > deadline) throw new ExportError("读取对话内容失败：" + err.message);
      await sleep(gapMs);
      continue;
    }

    if (requireNonEmpty && !items.length) {
      // 空快照：清零累计，继续等，绝不把它当成「稳定」
      sawEmpty = true;
      prevSig = null;
      sameCount = 0;
    } else {
      const sig = signatureOf(items);
      if (sig === prevSig) sameCount += 1;
      else { sameCount = 1; prevSig = sig; }
      if (sameCount >= need) return { items, samples: need, signature: sig };
    }

    if (Date.now() > deadline) {
      if (requireNonEmpty && !items.length) {
        throw new ExportError("等了 " + Math.round(timeoutMs / 1000) + " 秒页面还是空的（正文没渲染出来）"
          + "，已放弃导出。可能是登录态不一致、会话被删或网络没回来。");
      }
      throw new ExportError("页面在 " + Math.round(timeoutMs / 1000)
        + " 秒采样窗口内持续变化（疑似仍在流式输出），已放弃导出。");
    }
    await sleep(gapMs);
  }
}

// ---------------------------------------------------------------- 各子命令
function resolveStateDir(args) {
  return args["state-dir"] || process.env.QQBOT_STATE_DIR || DEFAULT_STATE_DIR;
}

// ---------------------------------------------------------------- 侧边栏只读扫描
const SIDEBAR_ITEM_SELECTOR = '[data-test-id="conversation"]';

/**
 * 后台窗口的「停靠矩形」：抄参照窗口的位置，只留几十像素贴在屏幕右缘。
 * 关键：Chrome 会把完全遮挡/离屏的后台窗口按不可见节流，对话正文因此永远不渲染；
 * 留一条边与显示器相交即可让渲染器正常工作，同时窗口几乎不可见、且不抢焦点。
 * 尺寸和位置都刻意与参照窗口错开，避免被窗口尺寸识别逻辑误认。
 */
async function computeParkRect(conn, port, botTargetId = "") {
  try {
    const list = await fetchJson("http://127.0.0.1:" + port + "/json/list", 1500);
    const pages = (list || []).filter((t) => t.type === "page" && /gemini\.google\.com/.test(String(t.url || "")));
    // 优先按 botTargetId 找参照窗口，找不到再退回第一个 Gemini 页
    const ref = (botTargetId && pages.find((t) => t.id === botTargetId)) || pages[0] || null;
    if (!ref) return null;
    const w = await conn.send("Browser.getWindowForTarget", { targetId: ref.id }, null, 8000);
    const b = await conn.send("Browser.getWindowBounds", { windowId: w.windowId }, null, 8000);
    const bounds = b && b.bounds;
    if (!bounds || bounds.windowState !== "normal" || !Number.isFinite(bounds.left)) return null;
    // 固定与参照窗口（900x800）明显错开的 960x740，避免被 FocusBroker.findSize(900,800) 误认
    const width = 960;
    const height = 740;
    let left = bounds.left + 24;
    // 参照窗口停在屏幕负坐标区（副屏右缘）时，把临时窗口再往左挪一点，别蹭到主屏
    if (bounds.left < 0) left = Math.min(left, -(width + 2));
    return { left, top: bounds.top + 48, width, height };
  } catch { return null; }
}

/** 只探测「列表壳是否出现、第一条是否已填充」，每轮 3 个 CDP 调用 */
async function sidebarProbe(conn, sessionId) {
  const doc = await conn.send("DOM.getDocument", { depth: 2 }, sessionId, 15000);
  const ids = (await conn.send("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: SIDEBAR_ITEM_SELECTOR }, sessionId, 15000)).nodeIds;
  if (!ids.length) return { count: 0, len: 0 };
  let len = 0;
  try { len = ((await conn.send("DOM.getOuterHTML", { nodeId: ids[0] }, sessionId, 15000)).outerHTML || "").length; } catch { len = 0; }
  return { count: ids.length, len };
}

async function readSidebarItems(conn, sessionId) {
  const doc = await conn.send("DOM.getDocument", { depth: 2 }, sessionId, 20000);
  const ids = (await conn.send("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: SIDEBAR_ITEM_SELECTOR }, sessionId, 20000)).nodeIds;
  const out = [];
  for (const nodeId of ids) {
    let html = "";
    try { html = (await conn.send("DOM.getOuterHTML", { nodeId }, sessionId, 20000)).outerHTML || ""; } catch { continue; }
    const item = parseConversationItem(html);
    if (item) out.push(item);
  }
  return out;
}

/**
 * 只在导出器自己新建的后台临时窗口里点一下（展开/收起侧边栏）。
 * 硬断言：没有 createdId、或 createdId 恰好是参照标签页时，一律拒绝发任何鼠标事件。
 */
async function clickByAriaLabel(conn, sessionId, labels, { createdId, botTargetId } = {}) {
  if (!createdId || (botTargetId && createdId === botTargetId)) return false;
  for (const label of labels) {
    let ids = [];
    try {
      const doc = await conn.send("DOM.getDocument", { depth: 2 }, sessionId, 15000);
      ids = (await conn.send("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: `[aria-label="${label}"]` }, sessionId, 15000)).nodeIds;
    } catch { ids = []; }
    for (const nodeId of ids.slice(0, 2)) {
      try {
        const box = await conn.send("DOM.getBoxModel", { nodeId }, sessionId, 10000);
        const c = box.model.content;
        const x = (c[0] + c[2] + c[4] + c[6]) / 4;
        const y = (c[1] + c[3] + c[5] + c[7]) / 4;
        await conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId, 10000);
        await conn.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, sessionId, 10000);
        await sleep(80);
        await conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, sessionId, 10000);
        return true;
      } catch {}
    }
  }
  return false;
}

/**
 * 在受控 Chrome 里开一个宽屏后台临时窗口，只读抓「置顶 + 近期」会话列表。
 * 绝不碰用户现有的 Gemini 标签页；结束时（含异常）必关窗口，并尽量把边栏状态还原。
 */
async function scanSidebar(ports, opts = {}) {
  if (!ports || !ports.length) fail("未发现受控 Chrome 调试端口，读不到侧边栏对话列表。");
  const botTargetId = opts.botTargetId || "";
  const p = ports[0];
  const conn = await new CdpConn(p.wsUrl).open();
  let createdId = null;
  let sessionId = null;
  let openedByUs = false;

  try {
    // 窗口停到屏幕右缘只留一条边：既让渲染器认为“可见”（否则正文永不渲染），又几乎不挡视线
    const rect = await computeParkRect(conn, p.port, botTargetId);
    const createParams = { url: "about:blank", background: true, newWindow: true };
    if (rect) Object.assign(createParams, rect);
    else Object.assign(createParams, { width: SIDEBAR_WINDOW.width, height: SIDEBAR_WINDOW.height });
    const created = await conn.send("Target.createTarget", createParams, null, 15000);
    createdId = created && created.targetId;
    if (!createdId) fail("无法创建侧边栏扫描用的后台临时窗口。");

    sessionId = await attachTarget(conn, createdId);
    await conn.send("Page.enable", {}, sessionId).catch(() => {});
    // 先用 Emulation 把布局视口钉成桌面宽屏，再导航（窗口本身可以很小/停在屏幕外）
    await conn.send("Emulation.setDeviceMetricsOverride", {
      width: SIDEBAR_WINDOW.width, height: SIDEBAR_WINDOW.height, deviceScaleFactor: 1, mobile: false,
    }, sessionId).catch(() => {});
    await conn.send("Page.navigate", { url: SIDEBAR_URL }, sessionId, 20000);

    const started = Date.now();
    const deadline = started + 45000;
    let items = [];

    for (;;) {
      const probe = await sidebarProbe(conn, sessionId).catch(() => ({ count: 0, len: 0 }));
      if (probe.count > 0 && probe.len >= 600) {
        // 壳已填充 → 正式读一遍
        items = await readSidebarItems(conn, sessionId);
        if (items.length) return items;
      }
      if (!openedByUs && (probe.count >= 1 || Date.now() - started > 12000)) {
        // 侧边栏处于收起态时，对话项只有空壳 —— 只在自己开的临时窗口内点开
        const clicked = await clickByAriaLabel(conn, sessionId, ["打开边栏", "Open sidebar"], { createdId, botTargetId }).catch(() => false);
        if (clicked) { openedByUs = true; await sleep(1500); continue; }
      }
      if (Date.now() > deadline) {
        fail("侧边栏 45 秒内没有渲染出对话列表（可能是登录态失效，或 Gemini 侧边栏改版）。");
      }
      await sleep(800);
    }
  } finally {
    if (openedByUs && sessionId) {
      try { await clickByAriaLabel(conn, sessionId, ["关闭边栏", "Close sidebar"], { createdId, botTargetId }); } catch {}
    }
    await detachTarget(conn, sessionId);
    if (createdId) { try { await conn.send("Target.closeTarget", { targetId: createdId }, null, 8000); } catch {} }
    conn.close();
  }
}

async function cmdListTargets(args) {
  const stateDir = resolveStateDir(args);
  const ports = await discoverPorts();
  const tabState = readJsonSafe(path.join(stateDir, "gemini_web_tab.json"), null);
  const botTargetId = tabState && tabState.targetId ? String(tabState.targetId) : "";
  const activity = readJsonSafe(path.join(stateDir, "cdp_activity.json"), null);
  const activityVerdict = evaluateActivity(activity, { now: Date.now() });

  const targets = [];
  for (const p of ports) {
    let pages = [];
    try {
      const list = await fetchJson("http://127.0.0.1:" + p.port + "/json/list", 1500);
      pages = (list || []).filter((t) => t.type === "page");
    } catch { continue; }
    const gemini = pages.filter((t) => String(t.url || "").includes("gemini.google.com"));
    if (!gemini.length) continue;

    let conn = null;
    try { conn = await new CdpConn(p.wsUrl).open(); } catch { conn = null; }
    for (const t of gemini) {
      const record = {
        port: p.port,
        browser: p.browser,
        targetId: t.id,
        title: String(t.title || ""),
        url: String(t.url || ""),
        is_bot_tab: botTargetId ? t.id === botTargetId : false,
        turns: 0,
        first_user: "",
        readable: false,
      };
      if (conn) {
        // 自动化任务正在操作页面时绝不并发附着它的标签页，只保留 /json/list 里的标题与地址
        if (record.is_bot_tab && activityVerdict.state === "busy_fresh") {
          record.readable = false;
          record.error = "后台自动化任务正在操作网页（" + (activityVerdict.phase || "busy") + "），请稍后导出";
        } else {
          let sessionId = null;
          try {
            sessionId = await attachTarget(conn, t.id);
            const items = await readNodes(conn, sessionId);
            const users = items.filter((i) => i.kind === "user");
            record.turns = users.length;
            record.readable = true;
            if (users.length) {
              const first = htmlToStructuredText(users[0].html, { extractThoughts: false }).text;
              record.first_user = first.replace(/\s+/g, " ").trim().slice(0, 42);
            }
          } catch (e) {
            record.readable = false;
            record.error = e.message;
          } finally {
            await detachTarget(conn, sessionId);
          }
        }
      }
      targets.push(record);
    }
    if (conn) conn.close();
  }

  // 侧边栏：置顶全部 + 最近 N 条（默认带 5 分钟缓存，避免每次开菜单都拉一次宽屏窗口）
  const botRec = targets.find((t) => t.targetId && t.targetId === botTargetId) || null;
  const botConvId = botRec ? conversationIdFromUrl(botRec.url) : "";
  const cache = loadSidebarCache();
  const cacheFresh = cache && (Date.now() - (cache.scanned_at_ms || 0)) < SIDEBAR_TTL_MS;
  let sidebarItems = [];
  const sidebarMeta = { scanned_at: "", from_cache: false, error: "" };

  if (args["no-sidebar"]) {
    sidebarMeta.error = "skipped";
  } else if (cacheFresh && !args.refresh) {
    sidebarItems = cache.items;
    sidebarMeta.scanned_at = cache.scanned_at || "";
    sidebarMeta.from_cache = true;
  } else {
    try {
      // 开临时窗口前先跟后台任务错峰（最多等 15 秒，等不到就跳过侧边栏，不硬开）
      if (activityVerdict.state === "busy_fresh") {
        try { await gateBotIdle(stateDir, { maxWaitMs: 15000 }); }
        catch (e) { logQuiet("sidebar_gate_skipped", e.message); }
      }
      sidebarItems = await scanSidebar(ports, { botTargetId });
      saveSidebarCache(sidebarItems);
      sidebarMeta.scanned_at = nowIso();
    } catch (e) {
      if (cache) {
        sidebarItems = cache.items;
        sidebarMeta.scanned_at = cache.scanned_at || "";
        sidebarMeta.from_cache = true;
        sidebarMeta.error = e.message;
      } else {
        sidebarMeta.error = e.message;
      }
    }
  }

  const view = buildSidebarView(sidebarItems, {
    excludeIds: botConvId ? [botConvId] : [],
    recentLimit: SIDEBAR_RECENT_LIMIT,
  });

  return {
    ok: true,
    generated_at: nowIso(),
    state_dir: stateDir,
    ports: ports.map((p) => p.port),
    bot_target_id: botTargetId || null,
    daemon: {
      activity_state: activityVerdict.state,
      phase: activityVerdict.phase || "",
      busy: Boolean(activity && activity.busy === true),
      pid: activity && activity.pid ? Number(activity.pid) : 0,
    },
    targets,
    sidebar: {
      pinned: view.pinned,
      recent: view.recent,
      scanned_at: sidebarMeta.scanned_at,
      from_cache: sidebarMeta.from_cache,
      error: sidebarMeta.error,
      total: sidebarItems.length,
      bot_conversation_id: botConvId || null,
    },
    notebooks: loadNotebooks().map((x) => ({ ...x, id: conversationIdFromUrl(x.url) })),
  };
}

async function pickPort(args, ports) {
  if (args.port) {
    const want = Number(args.port);
    const hit = ports.find((p) => p.port === want);
    if (!hit) fail("端口 " + want + " 上没有可用的 Chrome 调试实例。请确认受控 Chrome 仍在运行（--remote-debugging-port）。");
    return hit;
  }
  if (!ports.length) fail("未发现任何受控 Chrome 调试端口（29222~29299）。请先启动一个带调试端口的 Chrome。");
  return ports[0];
}

async function cmdExportCdp(args) {
  if (!args.target) fail("缺少 --target <targetId>");
  if (!args["out-json"]) fail("缺少 --out-json <path>");
  const stateDir = resolveStateDir(args);
  const isBot = Boolean(args["is-bot"]);

  // ① ② 忙闲门禁：只有自动化任务占用的标签页才需要；普通标签页只读一遍即可
  let gate = null;
  if (isBot) gate = await gateBotIdle(stateDir);

  const ports = await discoverPorts();
  const p = await pickPort(args, ports);
  const conn = await new CdpConn(p.wsUrl).open();
  let sessionId = null;
  try {
    // ③ 独立 flatten session：全程显式携带，绝不复用 daemon 的 sessionId / nodeId
    sessionId = await attachTarget(conn, args.target);
    // ④ 连续三次稳定快照
    const sample = await stableRead(conn, sessionId, { samples: STABLE_SAMPLES, gapMs: STABLE_GAP_MS });
    const conv = buildConversation(sample.items, { detailed: Boolean(args.detailed) });
    const title = (await targetTitle(conn, args.target)) || "Gemini 对话";

    // ⑤ 自动化窗口的流式收口校验
    if (isBot) {
      const done = botReplyComplete(conv);
      if (!done.ok) {
        fail("自动化窗口的末尾消息含【正文开始】但没有闭合结束符（[[END]] / 【END】），判定为流式未完结，拒绝导出。请等这一轮回复走完再试。");
      }
    }

    const out = {
      ok: true,
      mode: "cdp",
      source: isBot ? "bot_tab" : "user_tab",
      title,
      port: p.port,
      target_id: args.target,
      generated_at: nowIso(),
      detailed: Boolean(args.detailed),
      samples: sample.samples,
      gate,
      ...conv,
      stats: statsOf(conv, sample.items),
    };
    writeOut(args["out-json"], out);
    console.log("导出成功：" + out.turns.length + " 轮，未配对模型内容 " + out.unpaired_model_outputs.length + " 条 → " + args["out-json"]);
    return out;
  } finally {
    await detachTarget(conn, sessionId);
    conn.close();
  }
}

async function cmdExportHtml(args) {
  if (!args.file) fail("缺少 --file <htmlFilePath>");
  if (!args["out-json"]) fail("缺少 --out-json <path>");
  if (!fs.existsSync(args.file)) fail("HTML 文件不存在：" + args.file);
  const { html, title } = readHtmlFile(args.file);
  const nodes = scanConversationNodes(html);
  if (!nodes.length) {
    fail("这份 HTML 里没有找到 user-query / model-response 节点。请确认保存的是 Gemini 对话页（页面完全渲染后再保存）。");
  }
  const conv = buildConversation(nodes, { detailed: Boolean(args.detailed) });
  const out = {
    ok: true,
    mode: "html",
    source: "html_file",
    title: title || "Gemini 对话",
    file: args.file,
    generated_at: nowIso(),
    detailed: Boolean(args.detailed),
    ...conv,
    stats: statsOf(conv, nodes),
  };
  writeOut(args["out-json"], out);
  console.log("导出成功：" + out.turns.length + " 轮，未配对模型内容 " + out.unpaired_model_outputs.length + " 条 → " + args["out-json"]);
  return out;
}

async function cmdExportUrl(args) {
  if (!args.url) fail("缺少 --url <geminiUrl>");
  if (!args["out-json"]) fail("缺少 --out-json <path>");
  const url = String(args.url).trim();
  if (!isGeminiAppUrl(url)) {
    fail("只接受 https://gemini.google.com/app/... 或 /u/0/app/... 形式的会话地址（避免误开其它站点）。");
  }
  const stateDir = resolveStateDir(args);
  // 全路径忙闲门禁：临时窗口只在后台任务空闲时开，100% 与回合错峰
  await gateBotIdle(stateDir, { maxWaitMs: 45000 });
  const ports = await discoverPorts();
  const p = await pickPort(args, ports);
  const conn = await new CdpConn(p.wsUrl).open();
  const tabState = readJsonSafe(path.join(stateDir, "gemini_web_tab.json"), null);
  const botTargetId = tabState && tabState.targetId ? String(tabState.targetId) : "";
  let createdId = null;
  let sessionId = null;
  try {
    // 后台静默新建窗口：不激活、不置前（background: true）
    // 必须停在屏幕边缘留一条边，否则 Chrome 把不可见的后台窗口节流，对话正文永远不渲染
    const rect = await computeParkRect(conn, p.port, botTargetId);
    const createParams = { url, background: true, newWindow: true };
    if (rect) Object.assign(createParams, rect);
    const created = await conn.send("Target.createTarget", createParams, null, 15000);
    createdId = created && created.targetId;
    if (!createdId) fail("后台创建临时标签页失败");

    const deadline = Date.now() + 30000;
    let seen = null;
    for (;;) {
      if (Date.now() > deadline) fail("临时标签页 30 秒内没有就绪（可能是网络或登录页跳转）。");
      let list = [];
      try { list = await fetchJson("http://127.0.0.1:" + p.port + "/json/list", 1500); } catch {}
      seen = (list || []).find((t) => t.id === createdId) || null;
      if (seen) {
        const cur = String(seen.url || "");
        if (/accounts\.google\.com|servicelogin|RotateCookies/i.test(cur)) {
          fail("登录状态不一致：临时标签页被跳转到 " + cur + " 。本路径只在受控座舱已登录时可用。");
        }
        if (cur.includes("gemini.google.com") && seen.title) break;
      }
      await sleep(300);
    }

    sessionId = await attachTarget(conn, createdId);
    // 标题有值不代表正文渲染好了：必须等到真出现对话节点才开始算稳定（修 0|empty 假稳）
    // 后台标签页渲染长对话实测可达 30~40 秒，所以给 90 秒窗口
    const sample = await stableRead(conn, sessionId, {
      samples: STABLE_SAMPLES, gapMs: STABLE_GAP_MS, timeoutMs: 90000, requireNonEmpty: true,
    });
    const conv = buildConversation(sample.items, { detailed: Boolean(args.detailed) });
    const rawTitle = (await targetTitle(conn, createdId)) || (seen && seen.title) || "Gemini 对话";
    const title = cleanGeminiTitle(rawTitle) || "Gemini 对话";
    const out = {
      ok: true,
      mode: "url",
      source: "url_tab",
      title,
      url,
      port: p.port,
      target_id: createdId,
      generated_at: nowIso(),
      detailed: Boolean(args.detailed),
      ...conv,
      stats: statsOf(conv, sample.items),
    };
    // 导出成功 → 自动收藏（输过一次 URL 就永久常驻菜单）；侧边栏临时条目用 --no-favorite 跳过
    if (!args["no-favorite"]) {
      const fav = upsertNotebook({ url, title });
      if (fav) out.favorited = { id: fav.id, title: fav.title, added: fav.added };
    }
    writeOut(args["out-json"], out);
    console.log("导出成功：" + out.turns.length + " 轮 → " + args["out-json"]);
    if (out.favorited) console.log((out.favorited.added ? "已加入收藏：" : "已更新收藏：") + out.favorited.title);
    return out;
  } finally {
    await detachTarget(conn, sessionId);
    if (createdId) {
      // 100% 清理：只关自己开的那一个标签页
      try { await conn.send("Target.closeTarget", { targetId: createdId }, null, 8000); } catch {}
    }
    conn.close();
  }
}

function statsOf(conv, items) {
  return {
    user_nodes: (items || []).filter((i) => i.kind === "user").length,
    model_nodes: (items || []).filter((i) => i.kind === "model").length,
    turns: conv.turns.length,
    unpaired: conv.unpaired_model_outputs.length,
  };
}

function writeOut(filePath, obj) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

// ---------------------------------------------------------------- 自检
async function runSelftest() {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: Boolean(ok), detail });
    console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail && !ok ? "  ← " + detail : ""));
  };
  const eq = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    check(name, ok, ok ? "" : "actual=" + JSON.stringify(actual) + " expected=" + JSON.stringify(expected));
  };

  // ---- ① 代码块：缩进 / 反引号 / 换行原样保留
  const codeHtml = "<p>看这段：</p><pre><code class=\"language-js\"><span class=\"hljs-keyword\">const</span> a = 1;\n"
    + "  <span class=\"hljs-string\">`in`</span> ``` fence\n\tTab\t保留\n</code></pre><p>结束</p>";
  const codeOut = htmlToStructuredText(codeHtml).text;
  check("代码块保留 3 连反引号", codeOut.includes("``` fence"), codeOut);
  check("代码块保留两空格缩进", /\n {2}`in`/.test(codeOut) || codeOut.includes("  `in`"), JSON.stringify(codeOut));
  check("代码块保留制表符", codeOut.includes("\tTab\t保留"), JSON.stringify(codeOut));
  check("代码块剥离高亮 span", codeOut.includes("const a = 1;"), codeOut);
  eq("行内代码不额外换行", htmlToStructuredText("<p>用 <code>x = 1</code> 即可</p>").text, "用 x = 1 即可");

  // ---- ② 段落 / 列表 / 换行
  eq("段落与列表结构", htmlToStructuredText("<p>一</p><ul><li>甲</li><li>乙</li></ul><p>二</p>").text, "一\n- 甲\n- 乙\n二");
  eq("br 换行", htmlToStructuredText("<p>行一<br>行二</p>").text, "行一\n行二");
  eq("空行收敛", htmlToStructuredText("<div><br><br><br><br></div><p>尾</p>").text, "尾");

  // ---- ③ 引用 / 表格
  const quoteOut = htmlToStructuredText("<blockquote><p>引用一句</p></blockquote>").text;
  check("引用行前缀", quoteOut.startsWith("> 引用一句"), quoteOut);
  const tableOut = htmlToStructuredText("<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>").text;
  check("表格用制表符分隔且不含竖线", tableOut.includes("A\tB") && !tableOut.includes("|"), JSON.stringify(tableOut));

  // ---- ④ 思考节点分离
  const thoughtHtml = "<model-response><model-thoughts><div>先想一下</div></model-thoughts>"
    + "<div class=\"markdown\"><p>正式回复</p></div>"
    + "<div data-test-id=\"thought-panel\">隐藏思考</div></model-response>";
  const thought = htmlToStructuredText(thoughtHtml);
  eq("正文剥离思考节点", thought.text, "正式回复");
  eq("思考节点单独归档", thought.thoughts.length, 2);
  check("思考内容可读", thought.thoughts.join("|").includes("先想一下") && thought.thoughts.join("|").includes("隐藏思考"),
    JSON.stringify(thought.thoughts));

  // ---- ⑤ 实体解码
  eq("实体解码", decodeEntities("&lt;b&gt; &amp;lt; &quot;x&quot; &#39;y&#39; &#x4E2D; &nbsp;z"),
    "<b> &lt; \"x\" 'y' 中  z");

  // ---- ⑥ 未配对模型内容
  const nodes = [
    { kind: "user", html: "<user-query><p>问一</p></user-query>" },
    { kind: "model", html: "<model-response><p>答一</p></model-response>" },
    { kind: "user", html: "<user-query><p>问二</p></user-query>" },
    { kind: "model", html: "<model-response><p>答二v1</p></model-response>" },
    { kind: "model", html: "<model-response><p>答二v2</p></model-response>" },
    { kind: "model", html: "<model-response><p>没人认领的回复</p></model-response>" },
  ];
  const conv = buildConversation(nodes, { detailed: false });
  eq("轮次配对数量", conv.turns.length, 2);
  eq("多版本取最后稳定版本", conv.turns[1].model, "答二v2");
  eq("未配对归档", conv.unpaired_model_outputs, ["没人认领的回复"]);
  eq("简洁模式带清版模型文本", conv.turns[1].model_clean, "答二v2");
  check("简洁模式不输出 thoughts", conv.turns[0].thoughts === undefined);

  // ---- ⑦ 整页 HTML 扫描（文档顺序 + 配对栈）
  const page = "<html><head><title>我的会话</title></head><body>"
    + "<user-query><p>问题A</p></user-query><model-response><p>答案A</p></model-response>"
    + "<user-query><p>问题B</p></user-query><model-response><p>答案B</p></model-response>"
    + "</body></html>";
  const scanned = scanConversationNodes(page);
  eq("整页扫描节点数", scanned.length, 4);
  eq("整页扫描类型顺序", scanned.map((x) => x.kind), ["user", "model", "user", "model"]);

  // ---- ⑧ 忙闲门禁
  const NOW = 1700000000000;
  eq("门禁-文件缺失", evaluateActivity(null, { now: NOW }).state, "absent");
  eq("门禁-空闲", evaluateActivity({ busy: false, phase: "idle" }, { now: NOW }).state, "idle");
  eq("门禁-已停止", evaluateActivity({ busy: false, phase: "stopped", pid: 0 }, { now: NOW }).state, "idle");
  eq("门禁-忙碌且心跳新鲜",
    evaluateActivity({ busy: true, pid: 4242, updated_at_ms: NOW - 3000, phase: "hot_turn" },
      { now: NOW, staleMs: 15000, isPidAlive: (p) => p === 4242 }).state, "busy_fresh");
  eq("门禁-忙碌但心跳过期",
    evaluateActivity({ busy: true, pid: 4242, updated_at_ms: NOW - 60000 },
      { now: NOW, staleMs: 15000, isPidAlive: (p) => p === 4242 }).state, "busy_stale");
  eq("门禁-忙碌但进程已死",
    evaluateActivity({ busy: true, pid: 4242, updated_at_ms: NOW - 100 },
      { now: NOW, staleMs: 15000, isPidAlive: () => false }).state, "busy_dead");

  // ---- ⑨ 流式收口校验
  eq("收口-有正文无结束符", botReplyComplete({ turns: [{ model: "【正文开始】写到一半" }], unpaired_model_outputs: [] }).ok, false);
  eq("收口-有正文有结束符", botReplyComplete({ turns: [{ model: "【正文开始】正文[[END]]" }], unpaired_model_outputs: [] }).ok, true);
  eq("收口-不含信封不受影响", botReplyComplete({ turns: [{ model: "普通回复" }], unpaired_model_outputs: [] }).ok, true);
  eq("收口-结束符不在末尾不算完成", botReplyComplete({ turns: [{ model: "【正文开始】正文[[END]] 后面还有字" }], unpaired_model_outputs: [] }).ok, false);
  eq("收口-正文为空不算完成", botReplyComplete({ turns: [{ model: "【正文开始】[[END]]" }], unpaired_model_outputs: [] }).ok, false);

  // ---- ⑭ 签名要能识别「同长度不同内容」
  const sigA = signatureOf([{ kind: "model", html: "<p>aaaa</p>" }]);
  const sigB = signatureOf([{ kind: "model", html: "<p>bbbb</p>" }]);
  check("同长度不同内容签名不同", sigA !== sigB, sigA + " vs " + sigB);

  // ---- ⑩ 信封剥离
  eq("简洁模式剥离信封", stripEnvelope("【正文开始】哼，才不要呢 [STICKER:18] [[END]]"), "哼，才不要呢");
  eq("提示词侧保留语义标签", stripEnvelope("收到 [PASS] 后沉默【正文开始】", { controlTags: false }), "收到 [PASS] 后沉默");
  eq("剥信封不吞代码缩进", stripEnvelope("看这里 [[END]]\n    indented  code"), "看这里\n    indented code");

  // ---- ⑪ requireNonEmpty：空快照绝不算稳定（修 0|empty 假稳）
  const oneTurn = [{ kind: "user", html: "<user-query><p>问</p></user-query>" }];
  let calls = 0;
  const r1 = await stableRead(null, "fake", {
    samples: 3, gapMs: 1, timeoutMs: 2000, requireNonEmpty: true,
    reader: async () => { calls += 1; return calls <= 3 ? [] : oneTurn; },
  });
  eq("空快照不被当成稳定", r1.items.length, 1);
  check("空快照确实等了 3 轮", calls >= 6, "calls=" + calls);

  const r2 = await stableRead(null, "fake", { samples: 3, gapMs: 1, timeoutMs: 1000, reader: async () => [] });
  eq("不设 requireNonEmpty 时空页照旧判稳", r2.items.length, 0);

  let threwEmpty = false;
  try {
    await stableRead(null, "fake", { samples: 3, gapMs: 1, timeoutMs: 120, requireNonEmpty: true, reader: async () => [] });
  } catch (e) { threwEmpty = /空|没渲染/.test(e.message); }
  check("空页面等到超时会报错而不是导出 0 轮", threwEmpty);

  // ---- ⑫ 会话 URL / 侧边栏项解析
  eq("URL /app 取 id", conversationIdFromUrl("https://gemini.google.com/app/0123456789abcdef"), "0123456789abcdef");
  eq("URL /u/0/app 取 id", conversationIdFromUrl("https://gemini.google.com/u/0/app/0123456789abcdef"), "0123456789abcdef");
  eq("URL 无 id", conversationIdFromUrl("https://gemini.google.com/app"), "");
  check("笔记本地址判定", isGeminiAppUrl("https://gemini.google.com/u/0/app/0123456789abcdef") && !isGeminiAppUrl("https://example.com/app"));

  const itemHtml = '<gem-nav-list-item data-test-id="conversation" class="x"><a href="/app/89e3e40e31f2e3cf" aria-label="示例会话标题">'
    + '<span class="title-text gds-body-s">示例会话标题</span></a>'
    + '<gem-icon fonticonname="push_pin" aria-label="固定的对话"></gem-icon></gem-nav-list-item>';
  const parsedItem = parseConversationItem(itemHtml);
  eq("侧边栏项解析", [parsedItem.id, parsedItem.title, parsedItem.pinned], ["89e3e40e31f2e3cf", "示例会话标题", true]);
  eq("空壳项解析为空", parseConversationItem('<gem-nav-list-item data-test-id="conversation"><!----><!----></gem-nav-list-item>'), null);

  // ---- ⑬ 置顶全量 + 最新 5 去重
  const many = [];
  for (let i = 1; i <= 8; i++) many.push({ id: "a" + i, title: "置顶" + i, pinned: true });
  for (let i = 1; i <= 9; i++) many.push({ id: "r" + i, title: "近期" + i, pinned: false });
  many.push({ id: "a2", title: "置顶2", pinned: true });
  many.push({ id: "r1", title: "近期1", pinned: false });
  const view = buildSidebarView(many, { recentLimit: 5, excludeIds: ["a7"], excludeTitles: ["近期1"] });
  eq("置顶全量且排除指定项", view.pinned.map((x) => x.id), ["a1", "a2", "a3", "a4", "a5", "a6", "a8"]);
  eq("近期只取 5 条", view.recent.map((x) => x.id), ["r2", "r3", "r4", "r5", "r6"]);
  check("去重后无重复 id", new Set([...view.pinned, ...view.recent].map((x) => x.id)).size === 12);

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log("SELFTEST total=" + results.length + " pass=" + (results.length - failed.length) + " fail=" + failed.length);
  return failed.length === 0;
}

// ---------------------------------------------------------------- 入口
function usage() {
  return [
    "用法：",
    "  node gemini_web_chat_exporter.mjs list-targets",
    "  node gemini_web_chat_exporter.mjs export-cdp --port <p> --target <targetId> [--is-bot] [--detailed] --out-json <path>",
    "  node gemini_web_chat_exporter.mjs export-html --file <htmlPath> [--detailed] --out-json <path>",
    "  node gemini_web_chat_exporter.mjs export-url --url <geminiUrl> [--port <p>] [--detailed] --out-json <path>",
    "  node gemini_web_chat_exporter.mjs --selftest",
    "",
    "只读导出：绝不注入 JS、绝不激活窗口、绝不触碰历史栏与 Cookie。",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.selftest) {
    const ok = await runSelftest();
    process.exit(ok ? 0 : 1);
  }
  if (args.help || args.h || (!args._.length && !Object.keys(args).some((k) => k !== "_"))) {
    console.log(usage());
    process.exit(0);
  }

  const cmd = args._[0];
  let result;
  if (cmd === "list-targets") result = await cmdListTargets(args);
  else if (cmd === "export-cdp") result = await cmdExportCdp(args);
  else if (cmd === "export-html") result = await cmdExportHtml(args);
  else if (cmd === "export-url") result = await cmdExportUrl(args);
  else fail("未知子命令：" + cmd + "\n\n" + usage());

  if (cmd === "list-targets") process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

export {
  htmlToStructuredText,
  buildConversation,
  stripEnvelope,
  evaluateActivity,
  botReplyComplete,
  scanConversationNodes,
  readHtmlFile,
  signatureOf,
  stableRead,
  conversationIdFromUrl,
  isGeminiAppUrl,
  cleanGeminiTitle,
  parseConversationItem,
  buildSidebarView,
  loadNotebooks,
  upsertNotebook,
};

// 仅在被直接执行时才跑 CLI；被 import 时只暴露纯函数，便于自检与调试
const __entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
const __self = path.resolve(fileURLToPath(import.meta.url));
if (__entry && __entry.toLowerCase() === __self.toLowerCase()) {
  main().catch((err) => {
    const msg = err instanceof ExportError ? err.message : (err && err.message ? err.message : String(err));
    process.stderr.write("ERROR: " + msg + "\n");
    process.exit(2);
  });
}

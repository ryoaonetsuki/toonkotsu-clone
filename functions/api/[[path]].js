import rankings0Fallback from "../_data/rankings-sfw0.js";
import rankings1Fallback from "../_data/rankings-sfw1.js";
import chaptersFallback from "../_data/chapters.js";
import { json, dbChapter, dbMangaList, dbMangaByCode, localChapterPages, getSettings, getSessionUser, logAction, sessionCookies, uploadAvatarDataUrl, SESSION_MAX_AGE_SEC, persistRefreshedSession } from "../_lib/db.js";
import { sbSelect, sbInsert, sbUpdate, sbDelete, sbUpsert, sbCount, sbAuthTokenSignIn, sbAuthAdminCreateUser, sbAuthAdminUpdateUser, resolveEmail } from "../_lib/supabase.js";
import { adminHandler } from "../_lib/admin.js";

function hasDb(env) { return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY); }

export async function onRequest(context) {
  return persistRefreshedSession(context.request, await handleRequest(context));
}

async function handleRequest(context) {
  const url = new URL(context.request.url);
  const parts = context.params.path || [];
  if (parts[0] === "admin") return adminHandler(context);
  if (parts[0] === "site-settings" && context.request.method === "GET") {
    if (!hasDb(context.env)) return json({ site_name: "", footer_text: "", social_links: "{}", announcement: "", logo_url: "" });
    const s = await getSettings(context.env);
    return json({ site_name: s.site_name || "", footer_text: s.footer_text || "", social_links: s.social_links || "{}", announcement: s.announcement || "", logo_url: s.logo_url || "", maintenance: s.maintenance || "0", show_adult: s.show_adult || "0" });
  }
  if (parts[0] === "v1" && parts[1] === "rankings") {
    const sfw = url.searchParams.get("sfw") === "1";
    if (hasDb(context.env)) {
      try {
        const list = await dbMangaList(context.env);
        const allSeries = list.series || [];
        if (allSeries.length > 0) {
          const items = [];
          const seenTitles = new Set();
          for (const item of allSeries) {
            const key = String(item.title || "").trim().toLowerCase();
            if (seenTitles.has(key)) continue;
            seenTitles.add(key);
            items.push(item);
          }
          const base = sfw ? rankings1Fallback : rankings0Fallback;
          return json({ metric: base.metric, label: base.label, generatedAt: Date.now(), items, page: 1, limit: items.length, hasNextPage: false });
        }
      } catch {}
    }
    return json(sfw ? rankings1Fallback : rankings0Fallback);
  }
  if (parts[0] === "ads" && context.request.method === "GET") {
    if (!hasDb(context.env)) return json({ slots: {} });
    try {
      const rows = await sbSelect(context.env, "ads", { columns: "slot,network,ad_type,code", eq: { enabled: 1 } });
      const slots = {};
      for (const r of rows) if (r.code && String(r.code).trim()) slots[r.slot] = { network: r.network, ad_type: r.ad_type, code: r.code };
      return json({ slots });
    } catch { return json({ slots: {} }); }
  }
  // ---- public auth (Supabase Auth bridge; role always forced to 'user') ----
  if (parts[0] === "auth") {
    if (!hasDb(context.env)) return json({ error: "Database is not configured." }, 503);
    const method = context.request.method;
    let body = {};
    if (method === "POST") {
      try { body = await context.request.json(); } catch { body = {}; }
    }
    // The upstream session store builds identity.username from
    // displayName || username and falls back to the literal "Account".
    // The bridge previously returned only `name`, so EVERY logged-in user
    // displayed as "@Account" (and was misread as a guest). Return the
    // profile name under all three keys so the session identity is real.
    const pubUser = async (u) => {
      if (!u) return null;
      const uname = u.name || (u.email ? u.email.split("@")[0] : null);
      return { id: u.id, email: u.email, name: uname, username: uname, displayName: uname, avatar: u.avatar || null, role: u.role };
    };

    if (parts[1] === "providers" && method === "GET") {
      // The SPA auth components gate their forms on this flag (via /api/auth/providers):
      // a 404 here made register render "Sign-ups are closed" and hid the login cross-link.
      return json({ signup: true });
    }

    if (parts[1] === "register" && method === "POST") {
      // The SPA register form collects a username only (no email field), so accept
      // bare usernames exactly like the SPA-protocol register does: synthesize the
      // local-domain email and keep the username as the profile name.
      const rawUsername = String(body.username || "").trim();
      const email = String(body.email || (rawUsername.includes("@") ? rawUsername : "") || (rawUsername ? rawUsername.toLowerCase() + "@users.aonetsuki.local" : "")).trim().toLowerCase();
      // Display name: the real name shown after login (header/profile).
      // Empty -> fall back to the username, exactly like before.
      const displayName = String(body.display_name || body.displayName || body.name || "").trim().slice(0, 100);
      const name = displayName || (rawUsername && !rawUsername.includes("@") ? rawUsername : null);
      const password = String(body.password || "");
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "A valid email address is required." }, 400);
      if (password.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);
      // Profile picture (file upload only, never URL paste): upload to ImgBB
      // BEFORE creating the account, so a failed upload never leaves a
      // half-complete account without its picture.
      let avatarUrl = null;
      if (body.avatar_data) {
        const up = await uploadAvatarDataUrl(context.env, body.avatar_data);
        if (up.error) return json({ error: up.error }, 400);
        avatarUrl = up.url;
      }
      const dup = await sbSelect(context.env, "profiles", { columns: "id", eq: { email }, single: true }).catch(() => null);
      if (dup) return json({ error: "An account with this email already exists. Please log in instead." }, 409);
      let created;
      try {
        const meta = {};
        if (name) meta.display_name = name;
        if (avatarUrl) meta.avatar_url = avatarUrl;
        created = await sbAuthAdminCreateUser(context.env, email, password, meta);
      } catch {
        return json({ error: "Registration failed. Please try again." }, 500);
      }
      await sbInsert(context.env, "profiles", [{ id: created.id, email, name, role: "user", created_at: Date.now() }]).catch(() => {});
      try { await logAction(context.env, email, "Registered a new account"); } catch {}
      return json({ ok: true, user: { id: created.id, email, name, username: name, displayName: name, avatar: avatarUrl, role: "user" } });
    }

    if (parts[1] === "login" && method === "POST") {
      const ident = String(body.identifier || body.email || body.username || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!ident || !password) return json({ error: "Email and password are required." }, 400);
      const email = await resolveEmail(context.env, ident);
      let tokens;
      try {
        tokens = await sbAuthTokenSignIn(context.env, email, password);
      } catch {
        return json({ error: "Invalid email or password." }, 401);
      }
      const profile = await sbSelect(context.env, "profiles", { columns: "*", eq: { id: tokens.user.id }, single: true }).catch(() => null);
      if (!profile) return json({ error: "Invalid email or password." }, 401);
      if (profile.banned) return json({ error: "This account is banned." }, 403);
      try { await logAction(context.env, profile.email, "Logged in"); } catch {}
      return json({ ok: true, user: await pubUser(profile) }, 200, { setCookies: sessionCookies(tokens.access_token, tokens.refresh_token, SESSION_MAX_AGE_SEC) });
    }

    if (parts[1] === "logout" && method === "POST") {
      return json({ ok: true }, 200, { setCookies: sessionCookies(null, null, 0) });
    }

    if (parts[1] === "me") {
      const u = await getSessionUser(context.env, context.request);
      return json({ user: await pubUser(u) });
    }
    return json({ error: "Not found." }, 404);
  }

  // ---- account settings (frontend /settings/account; session-based) ----
  // The account page calls /api/v1/account/summary, /sessions, /password,
  // /export, /delete etc. None of these routes existed, so requests fell
  // through to ASSETS (SPA shell HTML) and the page crashed with
  // "Unexpected token '<' ... is not valid JSON". Implement the read +
  // password routes with real Supabase data; answer JSON (never HTML)
  // for the rest so the page shows a clean error instead of crashing.
  if (parts[0] === "v1" && parts[1] === "account") {
    if (!hasDb(context.env)) return json({ error: "Database is not configured." }, 503);
    const method = context.request.method;
    const user = await getSessionUser(context.env, context.request);
    if (!user) return json({ error: "Sign in to manage your account." }, 401);
    const uname = user.name || (user.email ? user.email.split("@")[0] : "Account");
    const sub = parts.slice(2);
    let body = {};
    if (method === "POST") {
      try { body = await context.request.json(); } catch { body = {}; }
    }
    if (sub.length === 1 && sub[0] === "summary" && method === "GET") {
      return json({ user: { id: user.id, username: uname, displayName: uname, email: user.email, standalone: false, hasUsablePassword: true, deletable: false, deleteRequestedAt: null, deleteEffectiveAt: null, canConfirmDeleteWithUsername: false } });
    }
    if (sub.length === 1 && sub[0] === "sessions" && method === "GET") {
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 20)));
      const ua = context.request.headers.get("user-agent") || "";
      let device = "Web browser";
      if (/android/i.test(ua)) device = "Android device";
      else if (/iphone|ipad/i.test(ua)) device = "iOS device";
      else if (/windows/i.test(ua)) device = "Windows PC";
      else if (/macintosh/i.test(ua)) device = "Mac";
      else if (/linux/i.test(ua)) device = "Linux PC";
      if (/edg/i.test(ua)) device += " · Edge";
      else if (/chrome/i.test(ua)) device += " · Chrome";
      else if (/firefox/i.test(ua)) device += " · Firefox";
      else if (/safari/i.test(ua)) device += " · Safari";
      const sessions = offset === 0 ? [{ id: "current", device, ip: context.request.headers.get("cf-connecting-ip") || null, lastSeen: Date.now(), current: true }] : [];
      return json({ sessions, total: 1, limit, hasMore: false });
    }
    if (sub.length === 1 && sub[0] === "export" && method === "GET") {
      const lib = await sbSelect(context.env, "user_library", { columns: "*", eq: { user_id: user.id } }).catch(() => []);
      const likes = await sbSelect(context.env, "manga_likes", { columns: "manga_id", eq: { user_id: user.id } }).catch(() => []);
      return new Response(JSON.stringify({ exportedAt: new Date().toISOString(), user: { id: user.id, email: user.email, name: user.name, role: user.role }, library: lib, likes }, null, 2), { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": 'attachment; filename="ani-account-data.json"' } });
    }
    if (sub.length === 1 && sub[0] === "password" && method === "POST") {
      const current = String(body.current || "");
      const next = String(body.next || "");
      if (!current || next.length < 6) return json({ error: "A new password of at least 6 characters is required." }, 400);
      try { await sbAuthTokenSignIn(context.env, user.email, current); }
      catch { return json({ error: "Your current password is incorrect." }, 401); }
      try { await sbAuthAdminUpdateUser(context.env, user.id, { password: next }); }
      catch { return json({ error: "Password change failed. Please try again." }, 500); }
      try { await logAction(context.env, user.email, "Changed password"); } catch {}
      return json({ ok: true });
    }
    // Per-device sign-out cannot revoke stateless Supabase JWTs from here,
    // and account deletion needs an owner decision + data model, so these
    // stay unimplemented — but answered as JSON, never the SPA shell.
    return json({ error: "This account action is not available." }, 501);
  }

  // ---- community service: title/chapter comments + reviews ----
  // The frontend discussion components call GET /api/v1/community?seriesId=…
  // and POST actions to /api/v1/community. This route NEVER existed, so
  // those requests fell through to ASSETS (the SPA shell HTML); the
  // frontend's response.json() failed and BOTH the Comments tab and the
  // Reviews tab showed "The community service returned an invalid answer."
  // Every branch below answers JSON, never HTML.
  if (parts[0] === "v1" && parts[1] === "community") {
    if (!hasDb(context.env)) return json({ error: "Database is not configured." }, 503);
    // Moderation-queue subpaths (same HTML-fallthrough class, previously
    // answered only by the 501 gate below): pending comments/reviews
    // awaiting review, and the moderation report list.
    if (parts.length === 3 && parts[2] === "submissions" && context.request.method === "GET") {
      const me = await getSessionUser(context.env, context.request).catch(() => null);
      if (!me || (me.role !== "admin" && me.role !== "moderator")) return json({ error: "Moderators only." }, 403);
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 20)));
      let submissions = [];
      try {
        const pendingComments = await sbSelect(context.env, "comments", { columns: "*", order: [["created_at", false]], limit: 200 }).catch(() => []);
        const pendingReviews = await sbSelect(context.env, "reviews", { columns: "*", order: [["created_at", false]], limit: 200 }).catch(() => []);
        for (const r of pendingComments) {
          if (r.status === "approved" || r.status === "published" || !r.status) continue;
          submissions.push({ id: `comment-${r.id}`, kind: "comment", targetId: r.manga_id, author: { id: r.user_id, username: r.user_name || "Reader", displayName: r.user_name || "Reader" }, text: r.body || "", status: r.status, createdAt: r.created_at });
        }
        for (const r of pendingReviews) {
          if (r.status === "approved" || r.status === "published" || !r.status) continue;
          submissions.push({ id: `review-${r.id}`, kind: "review", targetId: r.manga_id, author: { id: r.user_id, username: r.user_name || "Reader", displayName: r.user_name || "Reader" }, text: r.text || "", rating: Number(r.rating) || 0, status: r.status, createdAt: r.created_at });
        }
      } catch { submissions = []; }
      submissions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const total = submissions.length;
      return json({ submissions: submissions.slice(offset, offset + limit), pagination: { total, offset, limit } });
    }
    if (parts.length === 3 && parts[2] === "moderation" && context.request.method === "GET") {
      const me = await getSessionUser(context.env, context.request).catch(() => null);
      if (!me || (me.role !== "admin" && me.role !== "moderator")) return json({ error: "Moderators only." }, 403);
      let reports = [];
      try {
        const rows = await sbSelect(context.env, "reports", { columns: "*", order: [["created_at", false]], limit: 500 });
        const status = url.searchParams.get("status") || "open";
        const filtered = status === "all" ? rows : rows.filter((r) => (r.status || "open") === status);
        reports = filtered.map((r) => ({
          id: r.id, kind: r.kind || r.target_type || "request", targetId: Number(r.target_id) || null,
          content: { title: r.title || r.content_title || "" }, reason: r.reason || "",
          payload: { path: r.path || ((r.kind === "list" || r.target_type === "list") ? `/lists/${r.target_id}` : `/requests/${r.target_id}`) },
          status: r.status || "open", note: r.note || "", createdAt: r.created_at,
        }));
      } catch { reports = []; }
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 20)));
      return json({ reports: reports.slice(offset, offset + limit), queue: [], submissions: [], audit: [], pagination: { total: reports.length, offset, limit } });
    }
    if (parts.length > 2) return json({ error: "This community section is not available." }, 501);
    const method = context.request.method;
    const q = url.searchParams;
    const rawSeries = q.get("seriesId") || "";
    const numOrEcho = (v) => (/^\d+$/.test(String(v || "")) ? Number(v) : String(v || ""));
    // Resolve the frontend's series id to a manga row id. Title/chapter
    // pages pass the numeric row id; slugs/codes resolve via the same
    // lookup the title pages use. Unresolvable ids still get a valid
    // EMPTY discussion (never HTML, never a crash) so the tabs render.
    // GET carries seriesId in the query; POST carries it in the body.
    const resolveMangaId = async (raw) => {
      const v = String(raw ?? "");
      if (/^\d+$/.test(v)) return Number(v);
      if (!v) return null;
      try {
        const found = await dbMangaByCode(context.env, v);
        return found ? found.row.id : null;
      } catch { return null; }
    };
    const pubStatus = (s) => (s === "approved" ? "published" : (s || "published"));
    const authorOf = (row, me) => {
      const name = row.user_name || row.userName || "Reader";
      const avatar = me && String(me.id) === String(row.user_id) ? (me.avatar || null) : null;
      return { id: row.user_id, username: name, displayName: name, avatar };
    };
    if (method === "GET") {
      const me = await getSessionUser(context.env, context.request).catch(() => null);
      const mangaId = await resolveMangaId(rawSeries);
      const chapterRaw = q.get("chapterId");
      const chapterId = chapterRaw === null ? null : numOrEcho(chapterRaw);
      const sort = q.get("sort") || "newest";
      const offset = Math.max(0, Number(q.get("offset") || 0));
      const limit = Math.min(100, Math.max(1, Number(q.get("limit") || 20)));
      const parentRaw = q.get("parentId");
      // Comments: read from the existing comments table. Rows are fetched
      // in bulk and filtered in memory so a missing optional column
      // (chapter_id / parent_id / spoiler) can never break the list.
      let commentRows = [];
      if (mangaId) {
        try {
          commentRows = await sbSelect(context.env, "comments", { columns: "*", eq: { manga_id: mangaId }, order: [["created_at", sort === "oldest"]], limit: 200 });
        } catch { commentRows = []; }
      }
      let visible = commentRows.filter((r) => r.status === "approved" || r.status === "published" || !r.status);
      // Chapter scoping: only apply when rows actually carry chapter_id.
      if (chapterId !== null && visible.some((r) => r.chapter_id !== undefined && r.chapter_id !== null)) {
        visible = visible.filter((r) => Number(r.chapter_id) === Number(chapterId));
      }
      if (parentRaw !== null) {
        visible = visible.filter((r) => String(r.parent_id) === String(parentRaw));
      } else {
        visible = visible.filter((r) => r.parent_id === undefined || r.parent_id === null);
      }
      if (sort === "oldest") visible.sort((a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0));
      else visible.sort((a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0));
      const totalComments = visible.length;
      const pageComments = visible.slice(offset, offset + limit);
      // Votes (best-effort; missing table -> all zeros, never a failure).
      let voteMap = new Map();
      try {
        const ids = pageComments.map((r) => r.id).filter((v) => v !== undefined && v !== null);
        if (ids.length) {
          const votes = await sbSelect(context.env, "comment_votes", { columns: "comment_id,user_id,value", in: { comment_id: ids } });
          for (const v of votes) {
            let e = voteMap.get(Number(v.comment_id));
            if (!e) { e = { score: 0, mine: 0 }; voteMap.set(Number(v.comment_id), e); }
            e.score += Number(v.value) || 0;
            if (me && String(v.user_id) === String(me.id)) e.mine = Number(v.value) || 0;
          }
        }
      } catch {}
      const comments = pageComments.map((r) => {
        const v = voteMap.get(Number(r.id)) || { score: 0, mine: 0 };
        const canEdit = Boolean(me && (String(me.id) === String(r.user_id) || me.role === "admin"));
        return {
          id: r.id, author: authorOf(r, me), text: r.body || "", spoiler: Boolean(r.spoiler),
          status: pubStatus(r.status), createdAt: r.created_at, updatedAt: r.created_at,
          depth: r.parent_id ? 1 : 0, score: v.score, myVote: me ? v.mine : 0,
          myHelpful: false, canEdit, parentId: r.parent_id ?? null,
        };
      });
      // Reviews: from the reviews table (missing table -> empty list).
      let reviewRows = [];
      if (mangaId) {
        try {
          reviewRows = await sbSelect(context.env, "reviews", { columns: "*", eq: { manga_id: mangaId }, order: [["created_at", false]], limit: 200 });
        } catch { reviewRows = []; }
      }
      const liveReviews = reviewRows.filter((r) => r.status === "approved" || r.status === "published" || !r.status);
      if (sort === "oldest") liveReviews.sort((a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0));
      else liveReviews.sort((a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0));
      const totalReviews = liveReviews.length;
      const pageReviews = liveReviews.slice(offset, offset + limit);
      let helpfulMap = new Map();
      try {
        const ids = pageReviews.map((r) => r.id).filter((v) => v !== undefined && v !== null);
        if (ids.length) {
          const votes = await sbSelect(context.env, "review_votes", { columns: "review_id,user_id,helpful", in: { review_id: ids } });
          for (const v of votes) {
            let e = helpfulMap.get(Number(v.review_id));
            if (!e) { e = { count: 0, mine: false }; helpfulMap.set(Number(v.review_id), e); }
            if (v.helpful) e.count += 1;
            if (me && String(v.user_id) === String(me.id) && v.helpful) e.mine = true;
          }
        }
      } catch {}
      const reviews = pageReviews.map((r) => {
        const h = helpfulMap.get(Number(r.id)) || { count: 0, mine: false };
        const canEdit = Boolean(me && (String(me.id) === String(r.user_id) || me.role === "admin"));
        return {
          id: r.id, author: authorOf(r, me), rating: Number(r.rating) || 0, text: r.text || "",
          spoiler: Boolean(r.spoiler), status: pubStatus(r.status), createdAt: r.created_at, updatedAt: r.created_at,
          helpful: h.count, myHelpful: me ? h.mine : false, canEdit,
        };
      });
      // Rating from REAL reviews only: count, average, 1..10 distribution.
      const dist = [];
      for (let i = 1; i <= 10; i++) dist.push({ rating: i, count: 0 });
      let sum = 0;
      for (const r of liveReviews) {
        const rt = Number(r.rating);
        if (Number.isFinite(rt) && rt >= 1 && rt <= 10) { dist[Math.round(rt) - 1].count += 1; sum += rt; }
      }
      const rating = { count: liveReviews.length, average: liveReviews.length ? Math.round((sum / liveReviews.length) * 10) / 10 : 0, distribution: dist };
      let ownReview = null;
      if (me) {
        const mine = liveReviews.find((r) => String(r.user_id) === String(me.id));
        if (mine) {
          ownReview = {
            id: mine.id, author: authorOf(mine, me), rating: Number(mine.rating) || 0, text: mine.text || "",
            spoiler: Boolean(mine.spoiler), status: pubStatus(mine.status), createdAt: mine.created_at, updatedAt: mine.created_at,
            helpful: (helpfulMap.get(Number(mine.id)) || { count: 0 }).count, myHelpful: false, canEdit: true,
          };
        }
      }
      return json({
        seriesId: rawSeries ? numOrEcho(rawSeries) : null, chapterId,
        comments, reviews, polls: [], reactions: [], rating, ownReview,
        pagination: { comments: totalComments, reviews: totalReviews, polls: 0 },
        settings: { commentsEnabled: true, reviewsEnabled: true, pollsEnabled: true, reactionsEnabled: true },
      });
    }
    if (method === "POST") {
      const me = await getSessionUser(context.env, context.request).catch(() => null);
      if (!me) return json({ error: "Sign in to participate." }, 401);
      let body = {};
      try { body = await context.request.json(); } catch { body = {}; }
      const action = String(body.action || "");
      const mangaId = await resolveMangaId(body.seriesId);
      const name = me.name || (me.email ? me.email.split("@")[0] : "Reader");
      const isAdmin = me.role === "admin";
      const ownOrAdmin = (row) => isAdmin || String(row.user_id) === String(me.id);
      try {
        if (action === "comment.create") {
          if (!mangaId) return json({ error: "Series not found." }, 404);
          const text = String(body.text || "").trim();
          if (!text) return json({ error: "Comment text is required." }, 400);
          if (text.length > 2000) return json({ error: "Comment is too long." }, 400);
          const chapterNum = body.chapterId !== undefined && body.chapterId !== null && /^\d+$/.test(String(body.chapterId)) ? Number(body.chapterId) : null;
          const parentNum = body.parentId !== undefined && body.parentId !== null && /^\d+$/.test(String(body.parentId)) ? Number(body.parentId) : null;
          if (parentNum !== null) {
            const parent = await sbSelect(context.env, "comments", { columns: "id", eq: { id: parentNum }, single: true }).catch(() => null);
            if (!parent) return json({ error: "The comment you are replying to no longer exists." }, 400);
          }
          const base = { manga_id: mangaId, user_id: me.id, user_name: name, body: text, status: "approved", created_at: Date.now() };
          let rows = null;
          try {
            rows = await sbInsert(context.env, "comments", [{ ...base, chapter_id: chapterNum, parent_id: parentNum, spoiler: Boolean(body.spoiler) }]);
          } catch {
            // Optional columns (chapter_id / parent_id / spoiler) do not
            // exist yet: fall back to the known columns so posting still
            // works. Run migrations/0005-community.sql to enable scoping.
            rows = await sbInsert(context.env, "comments", [base]);
          }
          return json({ result: { id: rows.length ? rows[0].id : null, status: "published" } });
        }
        if (action === "comment.edit") {
          const row = await sbSelect(context.env, "comments", { columns: "*", eq: { id: Number(body.id) }, single: true }).catch(() => null);
          if (!row) return json({ error: "Comment not found." }, 404);
          if (!ownOrAdmin(row)) return json({ error: "You cannot edit this comment." }, 403);
          const text = String(body.text || "").trim();
          if (!text) return json({ error: "Comment text is required." }, 400);
          try { await sbUpdate(context.env, "comments", { body: text, spoiler: Boolean(body.spoiler) }, { id: Number(body.id) }); }
          catch { await sbUpdate(context.env, "comments", { body: text }, { id: Number(body.id) }); }
          return json({ result: { id: Number(body.id), status: "published" } });
        }
        if (action === "comment.delete") {
          const row = await sbSelect(context.env, "comments", { columns: "*", eq: { id: Number(body.id) }, single: true }).catch(() => null);
          if (!row) return json({ error: "Comment not found." }, 404);
          if (!ownOrAdmin(row)) return json({ error: "You cannot delete this comment." }, 403);
          await sbUpdate(context.env, "comments", { status: "deleted" }, { id: Number(body.id) });
          return json({ result: { id: Number(body.id), status: "deleted" } });
        }
        if (action === "comment.vote") {
          const value = Number(body.value) || 0;
          if (![-1, 0, 1].includes(value)) return json({ error: "Invalid vote." }, 400);
          const row = await sbSelect(context.env, "comments", { columns: "id", eq: { id: Number(body.id) }, single: true }).catch(() => null);
          if (!row) return json({ error: "Comment not found." }, 404);
          try {
            if (value === 0) await sbDelete(context.env, "comment_votes", { user_id: me.id, comment_id: Number(body.id) });
            else await sbUpsert(context.env, "comment_votes", [{ user_id: me.id, comment_id: Number(body.id), value }], "user_id,comment_id");
            const votes = await sbSelect(context.env, "comment_votes", { columns: "value", eq: { comment_id: Number(body.id) } }).catch(() => []);
            const score = votes.reduce((s, v) => s + (Number(v.value) || 0), 0);
            return json({ result: { id: Number(body.id), myVote: value, score } });
          } catch {
            return json({ error: "Voting is not available yet." }, 501);
          }
        }
        if (action === "review.save") {
          if (!mangaId) return json({ error: "Series not found." }, 404);
          const ratingVal = Number(body.rating);
          if (!Number.isFinite(ratingVal) || ratingVal < 1 || ratingVal > 10) return json({ error: "Rating must be between 1 and 10." }, 400);
          const text = String(body.text || "").trim();
          let existing = null;
          try {
            existing = await sbSelect(context.env, "reviews", { columns: "id", eq: { user_id: me.id, manga_id: mangaId }, single: true });
          } catch { existing = null; }
          try {
            if (existing) {
              try { await sbUpdate(context.env, "reviews", { rating: ratingVal, text, spoiler: Boolean(body.spoiler), status: "approved" }, { id: existing.id }); }
              catch { await sbUpdate(context.env, "reviews", { rating: ratingVal, text, status: "approved" }, { id: existing.id }); }
              return json({ result: { id: existing.id, status: "published" } });
            }
            let rows = null;
            try {
              rows = await sbInsert(context.env, "reviews", [{ manga_id: mangaId, user_id: me.id, user_name: name, rating: ratingVal, text, spoiler: Boolean(body.spoiler), status: "approved", created_at: Date.now() }]);
            } catch {
              rows = await sbInsert(context.env, "reviews", [{ manga_id: mangaId, user_id: me.id, user_name: name, rating: ratingVal, text, status: "approved", created_at: Date.now() }]);
            }
            return json({ result: { id: rows.length ? rows[0].id : null, status: "published" } });
          } catch {
            return json({ error: "Reviews are temporarily unavailable. Please try again in a minute." }, 503);
          }
        }
        if (action === "review.delete") {
          const row = await sbSelect(context.env, "reviews", { columns: "*", eq: { id: Number(body.id) }, single: true }).catch(() => null);
          if (!row) return json({ error: "Review not found." }, 404);
          if (!ownOrAdmin(row)) return json({ error: "You cannot delete this review." }, 403);
          await sbUpdate(context.env, "reviews", { status: "deleted" }, { id: Number(body.id) });
          return json({ result: { id: Number(body.id), status: "deleted" } });
        }
        if (action === "review.helpful") {
          const row = await sbSelect(context.env, "reviews", { columns: "id", eq: { id: Number(body.id) }, single: true }).catch(() => null);
          if (!row) return json({ error: "Review not found." }, 404);
          try {
            const helpful = body.value !== false;
            if (helpful) await sbUpsert(context.env, "review_votes", [{ user_id: me.id, review_id: Number(body.id), helpful: true }], "user_id,review_id");
            else await sbDelete(context.env, "review_votes", { user_id: me.id, review_id: Number(body.id) });
            const votes = await sbSelect(context.env, "review_votes", { columns: "helpful", eq: { review_id: Number(body.id) } }).catch(() => []);
            return json({ result: { id: Number(body.id), helpful: votes.filter((v) => v.helpful).length, myHelpful: helpful } });
          } catch {
            return json({ error: "Helpful votes are not available yet." }, 501);
          }
        }
        return json({ error: "This community action is not available." }, 501);
      } catch {
        return json({ error: "Community service is temporarily unavailable. Please try again in a minute." }, 503);
      }
    }
    return json({ error: "Not found." }, 404);
  }

  // ---- public reader library (session-based; guests get an empty list) ----
  if (parts[0] === "manga" && parts[1] === "library") {
    if (!hasDb(context.env)) return json({ error: "Database is not configured." }, 503);
    const method = context.request.method;
    const user = await getSessionUser(context.env, context.request);
    const toItem = (r) => ({ id: r.manga_id, slug: r.slug || "", title: r.title || "", cover: r.cover || null, status: r.status, addedAt: r.added_at, updatedAt: r.updated_at });
    if (method === "GET") {
      if (!user) return json({ items: [] });
      try {
        const rows = await sbSelect(context.env, "user_library", { columns: "*", eq: { user_id: user.id }, order: [["updated_at", false]] });
        return json({ items: rows.map(toItem) });
      } catch { return json({ items: [] }); }
    }
    if (!user) return json({ error: "Please log in." }, 401);
    let body = {};
    try { body = await context.request.json(); } catch { body = {}; }
    try {
      if (parts[2] === "merge" && method === "POST") {
        const items = Array.isArray(body.items) ? body.items : [];
        for (const it of items) {
          const mid = Number(it.id);
          if (!mid) continue;
          await sbUpsert(context.env, "user_library", [{
            user_id: user.id, manga_id: mid, slug: String(it.slug || ""), title: String(it.title || ""), cover: it.cover || null,
            status: String(it.status || "reading"), added_at: Number(it.addedAt) || Date.now(), updated_at: Number(it.updatedAt) || Date.now(),
          }], "user_id,manga_id");
        }
        const rows = await sbSelect(context.env, "user_library", { columns: "*", eq: { user_id: user.id }, order: [["updated_at", false]] });
        return json({ items: rows.map(toItem) });
      }
      const mid = Number(parts[2] || "0");
      if (!mid) return json({ error: "Manga id is required." }, 400);
      if (method === "PUT") {
        await sbUpsert(context.env, "user_library", [{
          user_id: user.id, manga_id: mid, slug: String(body.slug || ""), title: String(body.title || ""), cover: body.cover || null,
          status: String(body.status || "reading"), added_at: Number(body.addedAt) || Date.now(), updated_at: Number(body.updatedAt) || Date.now(),
        }], "user_id,manga_id");
        return json({ ok: true });
      }
      if (method === "DELETE") {
        await sbDelete(context.env, "user_library", { user_id: user.id, manga_id: mid });
        return json({ ok: true });
      }
    } catch {
      return json({ error: "Library is temporarily unavailable. Please try again in a minute." }, 503);
    }
    return json({ error: "Not found." }, 404);
  }

  // ---- manga view counts ("Reads" on title pages) ----
  // The title page calls GET /api/manga/views?ids=<id,...> and shows "N/A"
  // whenever a count is missing. This route NEVER existed, so the request
  // fell through to ASSETS (SPA shell HTML), the frontend's .json() failed,
  // and the catch left views null -> "N/A". Every requested id now gets a
  // real integer (rows in manga_views, or 0 when none exist yet — never a
  // fake inflated number). Chapter opens are logged best-effort in the
  // chapter route below, so counts grow for real from this deploy onward.
  if (parts[0] === "manga" && parts[1] === "views" && context.request.method === "GET") {
    const ids = (url.searchParams.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100);
    const views = {};
    for (const id of ids) {
      const mid = Number(id);
      if (!mid) { views[id] = 0; continue; }
      try { views[id] = await sbCount(context.env, "manga_views", { manga_id: mid }); }
      catch { views[id] = 0; }
    }
    return json({ views });
  }

  // ---- public manga likes + comments (session-based) ----
  if (parts[0] === "manga" && parts[2] === "likes" && /^\d+$/.test(parts[1] || "")) {
    if (!hasDb(context.env)) return json({ error: "Database is not configured." }, 503);
    const mid = Number(parts[1]);
    const method = context.request.method;
    if (method === "GET") {
      let count = 0, liked = false;
      try {
        count = await sbCount(context.env, "manga_likes", { manga_id: mid });
        const u = await getSessionUser(context.env, context.request);
        if (u) {
          const row = await sbSelect(context.env, "manga_likes", { columns: "user_id", eq: { user_id: u.id, manga_id: mid }, single: true }).catch(() => null);
          liked = Boolean(row);
        }
      } catch { return json({ count: 0, liked: false }); }
      return json({ count, liked });
    }
    if (method === "POST") {
      const u = await getSessionUser(context.env, context.request);
      if (!u) return json({ error: "Please log in." }, 401);
      try {
        const exists = await sbSelect(context.env, "manga_likes", { columns: "user_id", eq: { user_id: u.id, manga_id: mid }, single: true }).catch(() => null);
        if (exists) await sbDelete(context.env, "manga_likes", { user_id: u.id, manga_id: mid });
        else await sbInsert(context.env, "manga_likes", [{ user_id: u.id, manga_id: mid, created_at: Date.now() }], false);
        const count = await sbCount(context.env, "manga_likes", { manga_id: mid });
        return json({ ok: true, liked: !exists, count });
      } catch {
        return json({ error: "Likes are temporarily unavailable. Please try again in a minute." }, 503);
      }
    }
    return json({ error: "Not found." }, 404);
  }
  if (parts[0] === "manga" && parts[2] === "comments" && /^\d+$/.test(parts[1] || "")) {
    if (!hasDb(context.env)) return json({ error: "Database is not configured." }, 503);
    const mid = Number(parts[1]);
    const method = context.request.method;
    if (method === "GET") {
      try {
        const rows = await sbSelect(context.env, "comments", { columns: "id,user_id,user_name,body,status,created_at", eq: { manga_id: mid, status: "approved" }, order: [["id", false]], limit: 100 });
        return json({ items: rows });
      } catch { return json({ items: [] }); }
    }
    if (method === "POST") {
      const u = await getSessionUser(context.env, context.request);
      if (!u) return json({ error: "Please log in." }, 401);
      let body = {};
      try { body = await context.request.json(); } catch { body = {}; }
      const text = String(body.body || body.text || "").trim();
      if (!text) return json({ error: "Comment text is required." }, 400);
      if (text.length > 2000) return json({ error: "Comment is too long." }, 400);
      const name = u.name || (u.email ? u.email.split("@")[0] : "Reader");
      try {
        const rows = await sbInsert(context.env, "comments", [{ manga_id: mid, user_id: u.id, user_name: name, body: text, status: "approved", created_at: Date.now() }]);
        return json({ ok: true, id: rows.length ? rows[0].id : null });
      } catch {
        return json({ error: "Comments are temporarily unavailable. Please try again in a minute." }, 503);
      }
    }
    return json({ error: "Not found." }, 404);
  }
  if (parts[0] === "manga" && parts[1] === "chapter") {
    if (hasDb(context.env)) {
      try {
        const entry = await dbChapter(context.env, Number(parts[2] || "0"));
        if (entry) {
          // Log a real chapter open for the Reads counter. Best-effort:
          // if the manga_views table does not exist yet, this fails
          // silently and views simply stay 0 (see migrations/0005).
          try {
            const p = sbInsert(context.env, "manga_views", [{ manga_id: entry.series.id, chapter_id: entry.chapter.id, created_at: Date.now() }], false).catch(() => {});
            if (context.waitUntil) context.waitUntil(p); else await p;
          } catch {}
          return json(entry);
        }
      } catch {}
    }
    const entry = chaptersFallback[String(parts[2] || "")];
    if (!entry) return json({ error: "Chapter not found" }, 404);
    if (entry.chapter && Array.isArray(entry.chapter.pages)) {
      entry.chapter.pages = localChapterPages(entry.chapter.n, entry.chapter.pages);
    }
    return json(entry);
  }
  // ---- curation service: requests / lists / moderation ----
  // Same HTML-fallthrough failure class as community/views: these routes
  // never existed, so /requests showed "Invalid curation response." and
  // /lists, /moderation and the readers/lists pages failed the same way.
  // Every branch below answers JSON, never HTML. Reads work without any
  // table (valid empty states); writes that need a table from
  // migrations/0006-sweep.sql answer a clean JSON 501 until it is run.
  if (parts[0] === "v1" && parts[1] === "curation") {
    if (!hasDb(context.env)) return json({ error: "Database is not configured." }, 503);
    const method = context.request.method;
    const q = url.searchParams;
    const me = await getSessionUser(context.env, context.request).catch(() => null);
    const isStaff = Boolean(me && (me.role === "admin" || me.role === "moderator"));
    const authorOfRow = (row) => ({ id: row.user_id ?? null, username: row.user_name || "Reader", displayName: row.user_name || "Reader", avatar: null });
    const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
    const voteMapFor = async (table, idCol, ids, myId) => {
      const map = new Map();
      try {
        if (!ids.length) return map;
        const rows = await sbSelect(context.env, table, { columns: `user_id,${idCol}`, in: { [idCol]: ids } });
        for (const r of rows) {
          const k = Number(r[idCol]);
          let e = map.get(k);
          if (!e) { e = { score: 0, mine: false }; map.set(k, e); }
          e.score += 1;
          if (myId && String(r.user_id) === String(myId)) e.mine = true;
        }
      } catch {}
      return map;
    };
    const mapRequest = async (row, votes, seriesById) => {
      const v = votes.get(Number(row.id)) || { score: 0, mine: false };
      let resolution = null;
      const sid = row.resolution_series_id || row.series_id || null;
      if (sid && seriesById) {
        const s = seriesById.get(Number(sid));
        if (s) resolution = { series: { id: s.id, title: s.title, slug: s.slug || s.code || "", cover: s.cover || null } };
      }
      return {
        id: row.id, title: row.title || "", notes: row.notes || "", referenceUrl: row.reference_url || row.referenceUrl || "",
        externalIds: (() => { try { return typeof row.external_ids === "string" ? JSON.parse(row.external_ids) : (row.external_ids || {}); } catch { return {}; } })(),
        author: authorOfRow(row), score: v.score, myVote: v.mine, status: row.status || "open",
        moderationStatus: row.moderation_status || "approved", resolution,
        message: row.message || "", createdAt: row.created_at, updatedAt: row.created_at,
      };
    };
    const mapList = async (row, votes, items) => {
      const v = votes.get(Number(row.id)) || { score: 0, mine: false };
      return {
        id: row.id, title: row.title || "", description: row.description || "", author: authorOfRow(row),
        score: v.score, myVote: v.mine, status: row.status || "public",
        items: items || [], itemCount: (items || []).length, createdAt: row.created_at, updatedAt: row.created_at,
      };
    };
    const seriesIndex = async () => {
      try {
        const list = await dbMangaList(context.env);
        const m = new Map();
        for (const s of list.series || []) m.set(Number(s.id), s);
        return m;
      } catch { return new Map(); }
    };
    if (method === "GET") {
      const sub = parts.slice(2);
      const offset = Math.max(0, num(q.get("offset"), 0));
      const limit = Math.min(100, Math.max(1, num(q.get("limit"), 20)));
      if (sub.length === 1 && sub[0] === "requests") {
        let rows = [];
        try { rows = await sbSelect(context.env, "requests", { columns: "*", order: [["created_at", false]], limit: 500 }); } catch { rows = []; }
        const needle = (q.get("q") || "").trim().toLowerCase();
        const status = q.get("status") || "all";
        if (needle) rows = rows.filter((r) => String(r.title || "").toLowerCase().includes(needle));
        if (status !== "all") rows = rows.filter((r) => (r.status || "open") === status);
        const votes = await voteMapFor("request_votes", "request_id", rows.map((r) => Number(r.id)), me ? me.id : null);
        const mapped = [];
        for (const r of rows) mapped.push(await mapRequest(r, votes, null));
        if ((q.get("sort") || "top") === "top") mapped.sort((a, b) => (b.score - a.score) || ((b.createdAt || 0) - (a.createdAt || 0)));
        else mapped.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        const total = mapped.length;
        return json({ requests: mapped.slice(offset, offset + limit), pagination: { total, requests: total, offset, limit } });
      }
      if (sub.length === 1 && sub[0] === "mine") {
        if (!me) return json({ error: "Sign in to see your requests." }, 401);
        let rows = [];
        try { rows = await sbSelect(context.env, "requests", { columns: "*", eq: { user_id: me.id }, order: [["created_at", false]], limit: 500 }); } catch { rows = []; }
        const votes = await voteMapFor("request_votes", "request_id", rows.map((r) => Number(r.id)), me.id);
        const mapped = [];
        for (const r of rows) mapped.push(await mapRequest(r, votes, null));
        mapped.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        const total = mapped.length;
        return json({ requests: mapped.slice(offset, offset + limit), pagination: { total, requests: total, offset, limit } });
      }
      if (sub.length === 2 && sub[0] === "requests" && /^\d+$/.test(sub[1])) {
        let row = null;
        try { row = await sbSelect(context.env, "requests", { columns: "*", eq: { id: Number(sub[1]) }, single: true }); } catch { row = null; }
        if (!row) return json({ error: "Request not found." }, 404);
        const votes = await voteMapFor("request_votes", "request_id", [Number(row.id)], me ? me.id : null);
        return json({ request: await mapRequest(row, votes, await seriesIndex()) });
      }
      if (sub.length === 1 && sub[0] === "lists") {
        let rows = [];
        try { rows = await sbSelect(context.env, "lists", { columns: "*", order: [["created_at", false]], limit: 500 }); } catch { rows = []; }
        const needle = (q.get("q") || "").trim().toLowerCase();
        const authorId = q.get("authorId");
        if (needle) rows = rows.filter((r) => String(r.title || "").toLowerCase().includes(needle));
        if (authorId) rows = rows.filter((r) => String(r.user_id) === String(authorId));
        const votes = await voteMapFor("list_votes", "list_id", rows.map((r) => Number(r.id)), me ? me.id : null);
        const mapped = [];
        for (const r of rows) mapped.push(await mapList(r, votes, []));
        if ((q.get("sort") || "top") === "top") mapped.sort((a, b) => (b.score - a.score) || ((b.createdAt || 0) - (a.createdAt || 0)));
        else mapped.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        const total = mapped.length;
        return json({ lists: mapped.slice(offset, offset + limit), pagination: { total, lists: total, offset, limit } });
      }
      if (sub.length === 2 && sub[0] === "lists" && /^\d+$/.test(sub[1])) {
        let row = null;
        try { row = await sbSelect(context.env, "lists", { columns: "*", eq: { id: Number(sub[1]) }, single: true }); } catch { row = null; }
        if (!row) return json({ error: "List not found." }, 404);
        let items = [];
        try {
          const itemRows = await sbSelect(context.env, "list_items", { columns: "*", eq: { list_id: Number(sub[1]) }, order: [["position", true]] });
          items = itemRows.map((it) => ({ seriesId: Number(it.series_id), note: it.note || "", available: true }));
        } catch { items = []; }
        const votes = await voteMapFor("list_votes", "list_id", [Number(row.id)], me ? me.id : null);
        return json({ list: await mapList(row, votes, items), related: [] });
      }
      if (sub.length === 1 && sub[0] === "moderation") {
        if (!isStaff) return json({ error: "Moderators only." }, 403);
        let reports = [];
        try {
          const rows = await sbSelect(context.env, "reports", { columns: "*", order: [["created_at", false]], limit: 500 });
          const status = q.get("status") || "open";
          const filtered = status === "all" ? rows : rows.filter((r) => (r.status || "open") === status);
          reports = filtered.map((r) => ({
            id: r.id, kind: r.kind || r.target_type || "request", targetId: Number(r.target_id) || null,
            content: { title: r.title || r.content_title || "" }, reason: r.reason || "",
            payload: { path: r.path || ((r.kind === "list" || r.target_type === "list") ? `/lists/${r.target_id}` : `/requests/${r.target_id}`) },
            status: r.status || "open", note: r.note || "", createdAt: r.created_at,
          }));
        } catch { reports = []; }
        const total = reports.length;
        return json({ reports: reports.slice(offset, offset + limit), queue: [], submissions: [], audit: [], pagination: { total, offset, limit } });
      }
      return json({ error: "Not found." }, 404);
    }
    if (method === "POST") {
      if (!me) return json({ error: "Sign in to use curation." }, 401);
      let body = {};
      try { body = await context.request.json(); } catch { body = {}; }
      const action = String(body.action || "");
      const name = me.name || (me.email ? me.email.split("@")[0] : "Reader");
      const tableMissing = (e) => json({ error: "This curation feature needs the 0006-sweep migration. Please run migrations/0006-sweep.sql in the Supabase SQL editor." }, 501);
      try {
        if (action === "request.create") {
          const title = String(body.title || "").trim();
          if (!title) return json({ error: "A title is required." }, 400);
          if (title.length > 200) return json({ error: "Title is too long." }, 400);
          const base = { user_id: me.id, user_name: name, title, status: "open", created_at: Date.now() };
          let rows = null;
          try {
            rows = await sbInsert(context.env, "requests", [{ ...base, notes: String(body.notes || ""), reference_url: String(body.referenceUrl || ""), external_ids: JSON.stringify(body.externalIds || {}) }]);
          } catch {
            try { rows = await sbInsert(context.env, "requests", [base]); }
            catch { return tableMissing(); }
          }
          const row = rows.length ? rows[0] : { ...base, id: null };
          return json({ result: await mapRequest(row, new Map(), null) });
        }
        if (action === "request.edit") {
          const id = Number(body.id);
          const row = await sbSelect(context.env, "requests", { columns: "*", eq: { id }, single: true }).catch(() => null);
          if (!row) return json({ error: "Request not found." }, 404);
          if (!isStaff && String(row.user_id) !== String(me.id)) return json({ error: "You cannot edit this request." }, 403);
          const patch = { title: String(body.title || row.title || "") };
          if (body.notes !== undefined) patch.notes = String(body.notes || "");
          if (body.referenceUrl !== undefined) patch.reference_url = String(body.referenceUrl || "");
          try { await sbUpdate(context.env, "requests", patch, { id }); }
          catch { try { await sbUpdate(context.env, "requests", { title: patch.title }, { id }); } catch { return tableMissing(); } }
          const updated = await sbSelect(context.env, "requests", { columns: "*", eq: { id }, single: true }).catch(() => row);
          return json({ result: await mapRequest(updated, new Map(), null) });
        }
        if (action === "request.delete") {
          const id = Number(body.id);
          const row = await sbSelect(context.env, "requests", { columns: "*", eq: { id }, single: true }).catch(() => null);
          if (!row) return json({ error: "Request not found." }, 404);
          if (!isStaff && String(row.user_id) !== String(me.id)) return json({ error: "You cannot delete this request." }, 403);
          await sbDelete(context.env, "requests", { id });
          await sbDelete(context.env, "request_votes", { request_id: id }).catch(() => {});
          return json({ result: { id, deleted: true } });
        }
        if (action === "request.vote") {
          const id = Number(body.id);
          const row = await sbSelect(context.env, "requests", { columns: "id", eq: { id }, single: true }).catch(() => null);
          if (!row) return json({ error: "Request not found." }, 404);
          const want = body.value !== false;
          try {
            if (want) await sbUpsert(context.env, "request_votes", [{ user_id: me.id, request_id: id }], "user_id,request_id");
            else await sbDelete(context.env, "request_votes", { user_id: me.id, request_id: id });
            const score = await sbCount(context.env, "request_votes", { request_id: id });
            return json({ result: { id, score, myVote: want } });
          } catch { return tableMissing(); }
        }
        if (action === "request.resolve") {
          if (!isStaff) return json({ error: "Moderators only." }, 403);
          const id = Number(body.id);
          const row = await sbSelect(context.env, "requests", { columns: "*", eq: { id }, single: true }).catch(() => null);
          if (!row) return json({ error: "Request not found." }, 404);
          const status = String(body.status || "planned");
          if (!["planned", "fulfilled", "declined"].includes(status)) return json({ error: "Invalid status." }, 400);
          try { await sbUpdate(context.env, "requests", { status, message: String(body.message || ""), resolution_series_id: body.seriesId ? Number(body.seriesId) : null }, { id }); }
          catch { try { await sbUpdate(context.env, "requests", { status }, { id }); } catch { return tableMissing(); } }
          const updated = await sbSelect(context.env, "requests", { columns: "*", eq: { id }, single: true }).catch(() => ({ ...row, status }));
          return json({ result: await mapRequest(updated, new Map(), await seriesIndex()) });
        }
        if (action === "report.create") {
          const kind = String(body.kind || body.targetType || "request");
          const targetId = Number(body.targetId || body.target_id || 0);
          const reason = String(body.reason || "").trim();
          if (!targetId || !reason) return json({ error: "A target and a reason are required." }, 400);
          let rows = null;
          try {
            rows = await sbInsert(context.env, "reports", [{ kind, target_id: targetId, reason, user_id: me.id, user_name: name, status: "open", created_at: Date.now() }]);
          } catch {
            try { rows = await sbInsert(context.env, "reports", [{ reason, user_id: me.id, user_name: name, status: "open", created_at: Date.now() }]); }
            catch { return tableMissing(); }
          }
          return json({ result: { id: rows.length ? rows[0].id : null } });
        }
        if (action === "list.save") {
          const title = String(body.title || "").trim();
          if (!title) return json({ error: "A title is required." }, 400);
          const id = body.id ? Number(body.id) : null;
          if (id) {
            const row = await sbSelect(context.env, "lists", { columns: "*", eq: { id }, single: true }).catch(() => null);
            if (!row) return json({ error: "List not found." }, 404);
            if (!isStaff && String(row.user_id) !== String(me.id)) return json({ error: "You cannot edit this list." }, 403);
            try { await sbUpdate(context.env, "lists", { title, description: String(body.description || "") }, { id }); }
            catch { try { await sbUpdate(context.env, "lists", { title }, { id }); } catch { return tableMissing(); } }
          } else {
            try {
              const rows = await sbInsert(context.env, "lists", [{ user_id: me.id, user_name: name, title, description: String(body.description || ""), status: "public", created_at: Date.now() }]);
              const created = rows.length ? rows[0] : null;
              if (!created || !created.id) return tableMissing();
              if (Array.isArray(body.items)) {
                for (let i = 0; i < body.items.length; i++) {
                  const it = body.items[i];
                  const sid = Number(it.seriesId || it.series_id || 0);
                  if (sid) await sbInsert(context.env, "list_items", [{ list_id: created.id, series_id: sid, note: String(it.note || ""), position: i }]).catch(() => {});
                }
              }
              return json({ result: await mapList(created, new Map(), []) });
            } catch { return tableMissing(); }
          }
          const updated = await sbSelect(context.env, "lists", { columns: "*", eq: { id }, single: true }).catch(() => null);
          return json({ result: updated ? await mapList(updated, new Map(), []) : { id } });
        }
        if (action === "list.delete") {
          const id = Number(body.id);
          const row = await sbSelect(context.env, "lists", { columns: "*", eq: { id }, single: true }).catch(() => null);
          if (!row) return json({ error: "List not found." }, 404);
          if (!isStaff && String(row.user_id) !== String(me.id)) return json({ error: "You cannot delete this list." }, 403);
          await sbDelete(context.env, "lists", { id });
          await sbDelete(context.env, "list_items", { list_id: id }).catch(() => {});
          await sbDelete(context.env, "list_votes", { list_id: id }).catch(() => {});
          return json({ result: { id, deleted: true } });
        }
        if (action === "list.vote") {
          const id = Number(body.id);
          const row = await sbSelect(context.env, "lists", { columns: "id", eq: { id }, single: true }).catch(() => null);
          if (!row) return json({ error: "List not found." }, 404);
          const want = body.value !== false;
          try {
            if (want) await sbUpsert(context.env, "list_votes", [{ user_id: me.id, list_id: id }], "user_id,list_id");
            else await sbDelete(context.env, "list_votes", { user_id: me.id, list_id: id });
            const score = await sbCount(context.env, "list_votes", { list_id: id });
            return json({ result: { id, score, myVote: want } });
          } catch { return tableMissing(); }
        }
        if (action === "moderation.act") {
          if (!isStaff) return json({ error: "Moderators only." }, 403);
          const id = Number(body.id);
          const row = await sbSelect(context.env, "reports", { columns: "*", eq: { id }, single: true }).catch(() => null);
          if (!row) return json({ error: "Report not found." }, 404);
          const status = String(body.status || "resolved");
          try { await sbUpdate(context.env, "reports", { status, note: String(body.note || "") }, { id }); }
          catch { try { await sbUpdate(context.env, "reports", { status }, { id }); } catch { return tableMissing(); } }
          if (body.removeContent) {
            try {
              if ((row.kind || row.target_type) === "list") await sbDelete(context.env, "lists", { id: Number(row.target_id) });
              else await sbDelete(context.env, "requests", { id: Number(row.target_id) });
            } catch {}
          }
          return json({ result: { id, status } });
        }
        if (action === "moderation.settings") {
          if (!isStaff) return json({ error: "Moderators only." }, 403);
          try {
            await sbUpsert(context.env, "settings", [
              { key: "moderation_slow_mode_ms", value: String(num(body.slowModeMs, 0)) },
              { key: "moderation_word_filter", value: JSON.stringify(Array.isArray(body.wordFilter) ? body.wordFilter : []) },
            ], "key");
            return json({ result: { ok: true } });
          } catch { return tableMissing(); }
        }
        return json({ error: "This curation action is not available." }, 501);
      } catch {
        return json({ error: "Curation service is temporarily unavailable. Please try again in a minute." }, 503);
      }
    }
    return json({ error: "Not found." }, 404);
  }

  // ---- reader profiles service: readers directory / following / leaderboard / activity ----
  // Same failure class: /api/v1/profiles never existed, so the Readers page
  // (directory, following, activity, leaderboard) could not load at all.
  if (parts[0] === "v1" && parts[1] === "profiles") {
    if (!hasDb(context.env)) return json({ error: "Database is not configured." }, 503);
    const method = context.request.method;
    const q = url.searchParams;
    const me = await getSessionUser(context.env, context.request).catch(() => null);
    const offset = Math.max(0, Number(q.get("offset") || 0));
    const limit = Math.min(100, Math.max(1, Number(q.get("limit") || 20)));
    // Public reader card: never expose email addresses.
    const pubReader = (p, extra) => ({ id: p.id, username: p.name || (p.email ? p.email.split("@")[0] : "Reader"), displayName: p.name || (p.email ? p.email.split("@")[0] : "Reader"), avatar: p.avatar || null, ...(extra || {}) });
    if (method === "GET") {
      const sub = parts.slice(2);
      if (sub.length === 0) {
        let rows = [];
        try { rows = await sbSelect(context.env, "profiles", { columns: "*", order: [["created_at", false]], limit: 500 }); } catch { rows = []; }
        const needle = (q.get("query") || "").trim().toLowerCase();
        if (needle) rows = rows.filter((p) => String(p.name || "").toLowerCase().includes(needle));
        const total = rows.length;
        return json({ readers: rows.slice(offset, offset + limit).map((p) => pubReader(p)), pagination: { total, offset, limit } });
      }
      if (sub.length === 1 && sub[0] === "following") {
        // No follows table exists yet (see 0006-sweep: profile_follows);
        // until then the honest state is an empty following list.
        return json({ readers: [], pagination: { total: 0, offset, limit } });
      }
      if (sub.length === 1 && sub[0] === "leaderboard") {
        // No reading-activity data exists yet, so no honest leaderboard
        // can be computed. Empty state, not invented ranks.
        return json({ readers: [], pagination: { total: 0, offset, limit } });
      }
      if (sub.length === 1 && sub[0] === "activity") {
        return json({ activity: [], pagination: { total: 0, offset, limit } });
      }
      if (sub.length === 1 && sub[0] === "me") {
        if (!me) return json({ error: "Sign in to see your profile." }, 401);
        return json({ profile: pubReader(me) });
      }
      return json({ error: "Not found." }, 404);
    }
    if (method === "POST") {
      if (!me) return json({ error: "Sign in to use reader profiles." }, 401);
      let body = {};
      try { body = await context.request.json(); } catch { body = {}; }
      const action = String(body.action || "");
      const tableMissing = () => json({ error: "This profile feature needs the 0006-sweep migration. Please run migrations/0006-sweep.sql in the Supabase SQL editor." }, 501);
      try {
        if (action === "profile.publishSections") {
          try {
            await sbUpsert(context.env, "profile_sections", [{ user_id: me.id, sections: JSON.stringify(body.sections || body) }], "user_id");
            return json({ result: { ok: true } });
          } catch { return tableMissing(); }
        }
        if (action === "reading.complete" || action === "activity.record") {
          try {
            await sbInsert(context.env, "profile_activity", [{ user_id: me.id, kind: action, series_id: body.seriesId ? Number(body.seriesId) : null, chapter_id: body.chapterId ? Number(body.chapterId) : null, created_at: Date.now() }]);
            return json({ result: { recorded: true } });
          } catch { return tableMissing(); }
        }
        if (action === "follow.set") {
          try {
            if (body.follow === false) await sbDelete(context.env, "profile_follows", { user_id: me.id, target_id: String(body.targetId || body.target_id || "") });
            else await sbUpsert(context.env, "profile_follows", [{ user_id: me.id, target_id: String(body.targetId || body.target_id || "") }], "user_id,target_id");
            return json({ result: { ok: true, following: body.follow !== false } });
          } catch { return tableMissing(); }
        }
        if (action === "block.set") {
          try {
            if (body.block === false) await sbDelete(context.env, "blocks", { user_id: me.id, target_id: String(body.targetId || body.target_id || "") });
            else await sbUpsert(context.env, "blocks", [{ user_id: me.id, target_id: String(body.targetId || body.target_id || "") }], "user_id,target_id");
            return json({ result: { ok: true, blocked: body.block !== false } });
          } catch { return tableMissing(); }
        }
        return json({ error: "This profile action is not available." }, 501);
      } catch {
        return json({ error: "Reader service is temporarily unavailable. Please try again in a minute." }, 503);
      }
    }
    return json({ error: "Not found." }, 404);
  }

  // ---- notifications service (settings/notifications page + bell) ----
  if (parts[0] === "v1" && parts[1] === "notifications") {
    if (!hasDb(context.env)) return json({ error: "Database is not configured." }, 503);
    const method = context.request.method;
    const me = await getSessionUser(context.env, context.request).catch(() => null);
    if (!me) return json({ error: "Sign in to use account notifications." }, 401);
    if (method === "GET") {
      let settings = { newChapters: false, gaps: false, versions: false };
      try {
        const row = await sbSelect(context.env, "notification_settings", { columns: "settings", eq: { user_id: me.id }, single: true });
        if (row && row.settings) settings = { ...settings, ...(typeof row.settings === "string" ? JSON.parse(row.settings) : row.settings) };
      } catch {}
      let subscriptions = [];
      try {
        const rows = await sbSelect(context.env, "notification_subscriptions", { columns: "*", eq: { user_id: me.id }, order: [["created_at", false]] });
        subscriptions = rows.map((r) => ({ id: r.id, kind: r.kind || "library-rss", name: r.name || "", url: r.url || null, topic: r.topic || "chapter", enabled: r.enabled !== 0 && r.enabled !== false }));
      } catch {}
      return json({ settings, push: { configured: false }, subscriptions, notifications: [] });
    }
    if (method === "POST") {
      let body = {};
      try { body = await context.request.json(); } catch { body = {}; }
      const action = String(body.action || "");
      try {
        if (action === "settings.set" || body.settings) {
          const next = body.settings || {};
          const merged = { newChapters: Boolean(next.newChapters), gaps: Boolean(next.gaps), versions: Boolean(next.versions) };
          await sbUpsert(context.env, "notification_settings", [{ user_id: me.id, settings: JSON.stringify(merged) }], "user_id");
          return json({ result: { settings: merged } });
        }
        if (action === "subscription.add") {
          const rows = await sbInsert(context.env, "notification_subscriptions", [{ user_id: me.id, kind: String(body.kind || "library-rss"), name: String(body.name || ""), topic: String(body.topic || "chapter"), enabled: true, created_at: Date.now() }]);
          return json({ result: rows.length ? rows[0] : null });
        }
        if (action === "subscription.remove") {
          await sbDelete(context.env, "notification_subscriptions", { user_id: me.id, id: Number(body.id) });
          return json({ result: { id: Number(body.id), removed: true } });
        }
        if (action === "feed.create") {
          const rows = await sbInsert(context.env, "notification_subscriptions", [{ user_id: me.id, kind: "feed", name: String(body.name || ""), url: String(body.url || ""), topic: String(body.topic || "chapter"), enabled: true, created_at: Date.now() }]);
          return json({ result: rows.length ? rows[0] : null });
        }
        if (action === "feed.revoke") {
          await sbDelete(context.env, "notification_subscriptions", { user_id: me.id, id: Number(body.id) });
          return json({ result: { id: Number(body.id), removed: true } });
        }
        return json({ error: "This notification action is not available." }, 501);
      } catch {
        return json({ error: "Notifications need the 0006-sweep migration. Please run migrations/0006-sweep.sql in the Supabase SQL editor." }, 501);
      }
    }
    return json({ error: "Not found." }, 404);
  }

  // ---- reading statistics (settings/statistics page) ----
  // GET aggregates the signed-in user's synced reading events (none exist
  // yet, so honest zeros); POST stores events once 0006-sweep is run and
  // keeps them pending locally until then (the client retries by design).
  if (parts[0] === "v1" && parts[1] === "reading-statistics") {
    if (!hasDb(context.env)) return json({ error: "Database is not configured." }, 503);
    const method = context.request.method;
    const me = await getSessionUser(context.env, context.request).catch(() => null);
    if (!me) return json({ error: "Sign in to see reading statistics." }, 401);
    const emptyYear = (year) => ({ year, chaptersRead: 0, pagesRead: 0, activeMs: 0, longestStreak: 0, topTitles: [] });
    if (method === "GET") {
      const year = new Date().getUTCFullYear();
      let years = [];
      try {
        const events = await sbSelect(context.env, "reading_events", { columns: "*", eq: { user_id: me.id }, limit: 5000 });
        const byYear = new Map();
        const seriesNames = new Map();
        try {
          const list = await dbMangaList(context.env);
          for (const s of list.series || []) seriesNames.set(Number(s.id), s.title);
        } catch {}
        for (const ev of events) {
          const d = new Date(Number(ev.started_at) || 0);
          const y = d.getUTCFullYear();
          if (!y) continue;
          let agg = byYear.get(y);
          if (!agg) { agg = { ...emptyYear(y), _days: new Set(), _titles: new Map() }; byYear.set(y, agg); }
          agg._days.add(d.toISOString().slice(0, 10));
          if (ev.kind === "completion") agg.chaptersRead += 1;
          if (ev.kind === "page") agg.pagesRead += 1;
          if (ev.kind === "time" && Number.isFinite(Number(ev.ended_at)) && Number.isFinite(Number(ev.started_at))) agg.activeMs += Math.max(0, Number(ev.ended_at) - Number(ev.started_at));
          const t = agg._titles.get(Number(ev.series_id)) || { title: seriesNames.get(Number(ev.series_id)) || "Unknown", pagesRead: 0, chaptersRead: 0 };
          if (ev.kind === "page") t.pagesRead += 1;
          if (ev.kind === "completion") t.chaptersRead += 1;
          agg._titles.set(Number(ev.series_id), t);
        }
        const streakOf = (days) => {
          const sorted = [...days].sort();
          let best = 0, cur = 0, prev = null;
          for (const day of sorted) {
            const t = Date.parse(day + "T00:00:00Z");
            cur = (prev !== null && t - prev === 86400000) ? cur + 1 : 1;
            best = Math.max(best, cur);
            prev = t;
          }
          return best;
        };
        years = [...byYear.values()].sort((a, b) => b.year - a.year).map((a) => ({
          year: a.year, chaptersRead: a.chaptersRead, pagesRead: a.pagesRead, activeMs: a.activeMs,
          longestStreak: streakOf(a._days),
          topTitles: [...a._titles.values()].sort((x, y) => (y.pagesRead - x.pagesRead)).slice(0, 5),
        }));
      } catch { years = []; }
      const current = years.find((y) => y.year === year) || emptyYear(year);
      const totals = years.reduce((acc, y) => ({ chaptersRead: acc.chaptersRead + y.chaptersRead, pagesRead: acc.pagesRead + y.pagesRead, activeMs: acc.activeMs + y.activeMs, longestStreak: Math.max(acc.longestStreak, y.longestStreak) }), { chaptersRead: 0, pagesRead: 0, activeMs: 0, longestStreak: 0 });
      return json({ ...current, years, current, totals, topTitles: current.topTitles, pending: [], retained: 0 });
    }
    if (method === "POST") {
      let body = {};
      try { body = await context.request.json(); } catch { body = {}; }
      const events = Array.isArray(body.events) ? body.events : [];
      const valid = events.filter((ev) => ev && typeof ev.id === "string" && /^[a-f0-9-]{36}$/i.test(ev.id) && ["page", "time", "completion"].includes(ev.kind) && Number.isSafeInteger(ev.seriesId) && ev.seriesId > 0 && Number.isSafeInteger(ev.chapterId) && ev.chapterId > 0 && Number.isSafeInteger(ev.startedAt) && Number.isSafeInteger(ev.endedAt) && Number.isSafeInteger(ev.pageIndex) && Number.isSafeInteger(ev.pageCount));
      try {
        for (const ev of valid) {
          await sbUpsert(context.env, "reading_events", [{ id: ev.id, user_id: me.id, kind: ev.kind, series_id: ev.seriesId, chapter_id: ev.chapterId, started_at: ev.startedAt, ended_at: ev.endedAt, page_index: ev.pageIndex, page_count: ev.pageCount }], "id");
        }
        return json({ ok: true, accepted: valid.length, rejected: events.length - valid.length });
      } catch {
        return json({ error: "Reading statistics need the 0006-sweep migration. Please run migrations/0006-sweep.sql in the Supabase SQL editor." }, 501);
      }
    }
    return json({ error: "Not found." }, 404);
  }

  // ---- trackers (settings/trackers page; external tracker links) ----
  if (parts[0] === "v1" && parts[1] === "trackers") {
    const method = context.request.method;
    const q = url.searchParams;
    const me = await getSessionUser(context.env, context.request).catch(() => null);
    const sub = parts.slice(2);
    if (method === "GET" && sub.length === 1 && sub[0] === "progress") {
      const ids = (q.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
      const progress = {};
      for (const id of ids) progress[id] = 0;
      return json({ progress });
    }
    if (method === "GET" && sub.length === 0) {
      // No tracker links exist (no trackers table / no external accounts
      // linked). Empty list, not an error.
      return json({ trackers: [] });
    }
    if (!me) return json({ error: "Sign in to manage trackers." }, 401);
    return json({ error: "Tracker linking needs the 0006-sweep migration. Please run migrations/0006-sweep.sql in the Supabase SQL editor." }, 501);
  }

  // ---- transfers (settings/transfers page; external list import) ----
  // This needs external MangaDex/AniList/MAL list fetching plus a mapping
  // store, neither of which exists here. Bare GET renders an empty list;
  // every import sub-action answers clean JSON 501, never HTML.
  if (parts[0] === "v1" && parts[1] === "transfers") {
    const method = context.request.method;
    const me = await getSessionUser(context.env, context.request).catch(() => null);
    if (method === "GET" && parts.length === 2) return json({ transfers: [], data: [] });
    if (!me) return json({ error: "Sign in to use transfers." }, 401);
    return json({ error: "Transfer service is not available." }, 501);
  }

  // ---- status page / what's-new page (static honest empties) ----
  if (parts[0] === "v1" && parts[1] === "status" && context.request.method === "GET") {
    return json({ components: [], incidents: [] });
  }
  if (parts[0] === "v1" && parts[1] === "changes" && context.request.method === "GET") {
    return json({ entries: [] });
  }

  // ---- app state sync (offline-first; local storage stays source of truth) ----
  if (parts[0] === "v1" && parts[1] === "state") {
    if (context.request.method === "GET") return json({ revision: 0, state: {}, updatedAt: null });
    return json({ error: "State sync is not available." }, 501);
  }

  // ---- parental lock state (no lock is configured on this site) ----
  if (parts[0] === "v1" && parts[1] === "parental") {
    if (context.request.method === "GET") return json({ configured: false, unlocked: true, expiresAt: null, owner: null });
    return json({ ok: true, configured: false, unlocked: true });
  }

  // ---- page-failure telemetry (reader posts these; always 202, never an error) ----
  if (parts[0] === "v1" && parts[1] === "page-failures" && context.request.method === "POST") {
    try {
      let body = {};
      try { body = await context.request.json(); } catch { body = {}; }
      if (hasDb(context.env)) {
        await sbInsert(context.env, "page_failures", [{ path: String(body.path || ""), message: String(body.message || body.error || ""), created_at: Date.now() }]).catch(() => {});
      }
    } catch {}
    return json({ ok: true }, 202);
  }

  // ---- RSS feeds (settings/notifications page links) ----
  if (parts[0] === "v1" && parts[1] === "feeds") {
    const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const rss = (title, items) => new Response(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(title)}</title><link>${esc(url.origin)}</link><description>${esc(title)}</description>${items.map((it) => `<item><title>${esc(it.title)}</title><link>${esc(it.link)}</link><description>${esc(it.description || "")}</description></item>`).join("")}</channel></rss>`, { headers: { "content-type": "application/rss+xml; charset=utf-8" } });
    if (parts[2] === "latest.rss" && context.request.method === "GET") {
      let items = [];
      try {
        const list = await dbMangaList(context.env);
        items = (list.series || []).slice(0, 30).map((s) => ({ title: s.title, link: `${url.origin}/title/${encodeURIComponent(s.slug || s.code || s.id)}`, description: s.description || "" }));
      } catch {}
      return rss("Latest manga", items);
    }
    if (parts[2] === "title" && parts[3] && context.request.method === "GET") {
      if (!hasDb(context.env)) return json({ error: "Database is not configured." }, 503);
      const found = await dbMangaByCode(context.env, parts[3]).catch(() => null);
      if (!found) return json({ error: "Series not found" }, 404);
      const items = (found.chapters || []).slice(0, 30).map((ch) => ({ title: `${found.series.title} - Chapter ${ch.n}`, link: `${url.origin}/title/${encodeURIComponent(found.series.slug || found.series.code || found.series.id)}/chapter-${ch.n}`, description: "" }));
      return rss(found.series.title, items);
    }
    return json({ error: "Not found." }, 404);
  }

  // ---- structured-data metadata (page tolerates a missing jsonLd) ----
  if (parts[0] === "v1" && parts[1] === "metadata" && context.request.method === "GET") {
    const path = url.searchParams.get("path") || "";
    const m = /^\/title\/([^/]+)/.exec(path);
    if (m && hasDb(context.env)) {
      const found = await dbMangaByCode(context.env, m[1]).catch(() => null);
      if (found) {
        return json({ jsonLd: { "@context": "https://schema.org", "@type": "Book", name: found.series.title, author: found.series.author || undefined, url: `${url.origin}/title/${encodeURIComponent(found.series.slug || found.series.code || found.series.id)}` } });
      }
    }
    return json({});
  }

  // ---- MangaBaka availability probe (reader tolerates available:false) ----
  if (parts[0] === "v1" && parts[1] === "series" && parts[3] === "mangabaka" && context.request.method === "GET") {
    return json({ available: false });
  }

  // ---- chapter likes (title-page / reader like buttons) ----
  // THE reported like-button no-op: these routes never existed, so GET
  // fell through to the SPA shell HTML, the frontend's strict validation
  // threw, and the PUT toggle threw the same way — silently, with no
  // toast. Guests get a clean 401 ("Sign in to like chapters."); the
  // toggle contract below matches the frontend's validation exactly:
  // {chapterId, seriesId?, mine, likes} with likes null-or-integer.
  if (parts[0] === "manga" && parts[1] === "chapter-likes") {
    if (!hasDb(context.env)) return json({ error: "Database is not configured." }, 503);
    const method = context.request.method;
    const q = url.searchParams;
    const me = await getSessionUser(context.env, context.request).catch(() => null);
    const resolveSeriesId = async (raw) => {
      if (/^\d+$/.test(String(raw || ""))) return Number(raw);
      if (!raw) return null;
      try { const f = await dbMangaByCode(context.env, String(raw)); return f ? f.row.id : null; } catch { return null; }
    };
    if (method === "GET") {
      const seriesId = await resolveSeriesId(q.get("seriesId"));
      if (!seriesId) return json({ seriesId: q.get("seriesId"), counts: {}, mine: [] });
      let counts = {};
      try {
        const rows = await sbSelect(context.env, "chapter_likes", { columns: "chapter_id", eq: { manga_id: seriesId }, limit: 5000 });
        for (const r of rows) counts[Number(r.chapter_id)] = (counts[Number(r.chapter_id)] || 0) + 1;
      } catch { counts = {}; }
      let mine = [];
      if (me) {
        try {
          const rows = await sbSelect(context.env, "chapter_likes", { columns: "chapter_id", eq: { user_id: me.id, manga_id: seriesId }, limit: 5000 });
          mine = rows.map((r) => Number(r.chapter_id));
        } catch { mine = []; }
      }
      return json({ seriesId, counts, mine });
    }
    if (method === "PUT") {
      if (!me) return json({ error: "Sign in to like chapters." }, 401);
      let body = {};
      try { body = await context.request.json(); } catch { body = {}; }
      const seriesId = await resolveSeriesId(body.seriesId);
      const chapterId = Number(body.chapterId);
      if (!seriesId || !chapterId) return json({ error: "Series and chapter are required." }, 400);
      try {
        await sbUpsert(context.env, "chapter_likes", [{ user_id: me.id, manga_id: seriesId, chapter_id: chapterId, created_at: Date.now() }], "user_id,chapter_id");
        const likes = await sbCount(context.env, "chapter_likes", { chapter_id: chapterId });
        return json({ chapterId, seriesId, mine: true, likes });
      } catch {
        return json({ error: "Chapter likes need the 0006-sweep migration. Please run migrations/0006-sweep.sql in the Supabase SQL editor." }, 501);
      }
    }
    if (method === "DELETE" && parts[2] && /^\d+$/.test(parts[2])) {
      if (!me) return json({ error: "Sign in to like chapters." }, 401);
      const chapterId = Number(parts[2]);
      try {
        await sbDelete(context.env, "chapter_likes", { user_id: me.id, chapter_id: chapterId });
        const likes = await sbCount(context.env, "chapter_likes", { chapter_id: chapterId });
        return json({ chapterId, mine: false, likes });
      } catch {
        return json({ error: "Chapter likes need the 0006-sweep migration. Please run migrations/0006-sweep.sql in the Supabase SQL editor." }, 501);
      }
    }
    return json({ error: "Not found." }, 404);
  }

  // ---- upload-guard dashboard (moderation page; staff only) ----
  if (parts[0] === "manga" && parts[1] === "guard" && context.request.method === "GET") {
    const me = await getSessionUser(context.env, context.request).catch(() => null);
    if (!me || (me.role !== "admin" && me.role !== "moderator")) return json({ error: "Moderators only." }, 403);
    return json({ busiest: [] });
  }

  return context.env.ASSETS.fetch(context.request);
}

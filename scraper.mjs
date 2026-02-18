import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'https://theqoo.net';
const BOARD_PATH = '/akb48';
const LOGIN_URL = `${BASE_URL}/?act=dispMemberLoginForm`;
const DAYS_BACK = 3;
const DELAY_MS = { min: 1000, max: 2000 };
const CACHE_PATH = path.join(process.cwd(), 'output', 'posts_cache.json');

function compressText(text) {
  if (!text) return '';
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveCache(cache) {
  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay() {
  const ms = DELAY_MS.min + Math.random() * (DELAY_MS.max - DELAY_MS.min);
  return sleep(ms);
}

function parseTheqooDate(dateStr) {
  const trimmed = dateStr.trim();
  const now = new Date();

  if (/^\d{1,2}:\d{2}$/.test(trimmed)) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (/^\d{4}\.\d{2}\.\d{2}$/.test(trimmed)) {
    const [y, m, d] = trimmed.split('.').map(Number);
    return new Date(y, m - 1, d);
  }
  if (/^\d{2}\.\d{2}\.\d{2}$/.test(trimmed)) {
    const [y, m, d] = trimmed.split('.').map(Number);
    return new Date(2000 + y, m - 1, d);
  }
  if (/^\d{1,2}\.\d{1,2}$/.test(trimmed)) {
    const [m, d] = trimmed.split('.').map(Number);
    return new Date(now.getFullYear(), m - 1, d);
  }
  if (trimmed.includes('분 전') || trimmed.includes('시간 전')) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  console.warn(`알 수 없는 날짜 형식: "${trimmed}"`);
  return null;
}

function isWithinDays(date, days) {
  if (!date) return false;
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  return date >= cutoff;
}

async function login(page) {
  const id = process.env.THEQOO_ID;
  const pw = process.env.THEQOO_PW;
  if (!id || !pw) throw new Error('.env에 THEQOO_ID/THEQOO_PW 필요');

  console.log('로그인 중...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await sleep(1000);
  await page.fill('input[name="user_id"]', id);
  await page.fill('input[name="password"]', pw);
  await page.click('.btn-login, input[type="submit"], button[type="submit"]');
  await page.waitForLoadState('domcontentloaded');
  await sleep(2000);

  const stillOnLogin = await page.$('input[name="password"]');
  if (stillOnLogin) throw new Error('로그인 실패');
  console.log('로그인 성공!');
}

async function collectPostList(page) {
  const posts = [];
  let pageNum = 1;
  let shouldStop = false;

  while (!shouldStop) {
    const url = `${BASE_URL}${BOARD_PATH}?page=${pageNum}`;
    console.log(`글 목록 수집 중... 페이지 ${pageNum}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(1000);

    const rows = await page.$$('table.bd_lst tbody tr:not(.notice)');
    if (rows.length === 0) break;

    for (const row of rows) {
      try {
        const titleEl = await row.$('td.title a, td.title .title_wrapper a');
        if (!titleEl) continue;
        const title = (await titleEl.innerText()).trim();
        const href = await titleEl.getAttribute('href');
        const postUrl = href?.startsWith('http') ? href : `${BASE_URL}${href}`;

        const dateEl = await row.$('td.time, td.date');
        const dateStr = dateEl ? (await dateEl.innerText()).trim() : '';
        const postDate = parseTheqooDate(dateStr);

        if (!isWithinDays(postDate, DAYS_BACK)) {
          console.log(`${DAYS_BACK}일 이전 글 발견 (${dateStr}). 수집 중단.`);
          shouldStop = true;
          break;
        }

        const viewEl = await row.$('td.m_no, td.readNum');
        let views = 0;
        if (viewEl) {
          views = parseInt((await viewEl.innerText()).trim().replace(/,/g, ''), 10) || 0;
        }

        let comments = 0;
        const commentEl = await row.$('td.title .replyNum, td.title .cmt, a.replyNum');
        if (commentEl) {
          comments = parseInt((await commentEl.innerText()).trim().replace(/[\[\](),]/g, ''), 10) || 0;
        }

        posts.push({ title, url: postUrl, date: dateStr, postDate, views, comments });
      } catch (err) {
        console.warn('행 파싱 오류:', err.message);
      }
    }
    pageNum++;
    await randomDelay();
  }

  console.log(`총 ${posts.length}개 글 수집 완료.`);
  return posts;
}

async function collectPostContents(page, posts) {
  const cache = loadCache();
  let cached = 0, fetched = 0;

  console.log(`\n글 본문+댓글 수집 시작 (${posts.length}개, 캐시 ${Object.keys(cache).length}건)...`);

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];

    // 캐시에 있으면 스킵
    if (cache[post.url]) {
      post.content = cache[post.url].content;
      post.topComments = cache[post.url].topComments;
      cached++;
      continue;
    }

    try {
      console.log(`  [${i + 1}/${posts.length}] ${post.title.substring(0, 40)}...`);
      await page.goto(post.url, { waitUntil: 'domcontentloaded' });
      await sleep(500);

      // 본문
      const contentEl = await page.$('div.rd_body article, div.rd_body .xe_content, div.document_srl .xe_content');
      const rawContent = contentEl ? (await contentEl.innerText()).trim() : '';
      post.content = compressText(rawContent);

      // 댓글 수집
      post.topComments = [];
      const commentEls = await page.$$('.fdb_lst_ul li.fdb_itm, .comment_list .comment-item, .cmt_list li');
      for (const el of commentEls.slice(0, 10)) {
        try {
          const textEl = await el.$('.comment-content, .xe_content, .cmt_content, .fdb_itm_cont');
          if (textEl) {
            const text = compressText((await textEl.innerText()).trim());
            if (text) post.topComments.push(text);
          }
        } catch {}
      }

      // 캐시 저장
      cache[post.url] = { content: post.content, topComments: post.topComments };
      fetched++;

      await randomDelay();
    } catch (err) {
      console.warn(`  수집 실패: ${err.message}`);
      post.content = '';
      post.topComments = [];
    }
  }

  saveCache(cache);
  console.log(`본문+댓글 수집 완료. (새로 수집: ${fetched}, 캐시 사용: ${cached})`);
}

async function summarizeWithGemini(posts) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('GEMINI_API_KEY 없음. 요약 건너뜀.');
    return '(Gemini API 키가 설정되지 않아 요약을 생성하지 못했습니다.)';
  }

  // 글 데이터를 텍스트로 정리 (본문 더 많이 포함)
  const postsText = posts.map(p => {
    let entry = `[${p.date}] ${p.title} (조회${p.views}/댓글${p.comments})\n본문: ${(p.content || '').substring(0, 500)}`;
    if (p.topComments?.length > 0) {
      entry += `\n주요댓글:\n${p.topComments.slice(0, 5).map(c => `  - ${c.substring(0, 100)}`).join('\n')}`;
    }
    return entry;
  }).join('\n---\n');

  const prompt = `당신은 AKB48/48그룹 팬 커뮤니티 분석 전문가입니다.
다음은 theqoo.net의 AKB48 게시판에서 최근 ${DAYS_BACK}일간 올라온 ${posts.length}개의 글과 댓글입니다.

아래 형식으로 상세하게 한국어로 요약해주세요. 각 섹션을 충분히 길고 구체적으로 작성하세요.

## 1. 전체 분위기/트렌드 (3~5문장)
이 기간 커뮤니티의 전반적 분위기, 주된 관심사, 활발했던 주제의 흐름을 서술하세요.

## 2. 주요 토픽별 상세 정리
각 토픽마다 소제목을 달고, 무슨 일이 있었는지, 팬들의 반응은 어땠는지, 관련 글이 몇 건이나 되는지 구체적으로 정리하세요.
- 각 토픽은 3~5문장으로 상세 서술
- 언급된 멤버 이름을 구체적으로 포함
- 댓글 반응도 반영

## 3. 주목할 만한 개별 글 (3~5건)
조회수나 댓글이 많았거나, 흥미로운 논의가 있었던 글을 골라 제목과 함께 왜 화제가 되었는지 설명하세요.

## 4. 팬덤 반응 & 감성 분석 (3~5문장)
팬들이 어떤 주제에 가장 뜨겁게 반응했는지, 전체적인 감성(긍정/부정/기대감 등)은 어떠한지 분석하세요.

글 목록:
${postsText}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  try {
    console.log('\nGemini API로 요약 생성 중...');
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Gemini API 오류:', resp.status, errText);
      return `(Gemini API 오류: ${resp.status})`;
    }

    const data = await resp.json();
    const summary = data.candidates?.[0]?.content?.parts?.[0]?.text || '(요약 생성 실패)';
    console.log('요약 생성 완료!');
    return summary;
  } catch (err) {
    console.error('Gemini API 호출 실패:', err.message);
    return `(요약 생성 실패: ${err.message})`;
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateHtmlReport(posts, geminiSummary) {
  const now = new Date();
  const dateLabel = now.toISOString().slice(0, 10);

  const top10Views = [...posts].sort((a, b) => b.views - a.views).slice(0, 10);
  const top10Comments = [...posts].sort((a, b) => b.comments - a.comments).slice(0, 10);

  // Gemini 요약의 마크다운을 간단 HTML로 변환
  const summaryHtml = escapeHtml(geminiSummary)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^\* (.+)$/gm, '<li>$1</li>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>')
    .replace(/\n/g, '<br>');

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>theqoo /akb48 리포트 - ${dateLabel}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0f0f0f; color: #e0e0e0; line-height: 1.6; padding: 20px;
    max-width: 1100px; margin: 0 auto;
  }
  h1 { color: #ff6b9d; font-size: 1.8em; margin-bottom: 4px; }
  .subtitle { color: #888; font-size: 0.9em; margin-bottom: 30px; }
  h2 { color: #ff6b9d; font-size: 1.3em; margin: 30px 0 15px; padding-bottom: 8px; border-bottom: 1px solid #333; }
  .summary-box {
    background: #1a1a2e; border: 1px solid #333; border-radius: 10px;
    padding: 20px; margin-bottom: 25px; line-height: 1.8;
  }
  .summary-box h3, .summary-box h4 { color: #ff6b9d; margin: 10px 0 5px; }
  .summary-box li { margin-left: 20px; margin-bottom: 4px; }
  .summary-box strong { color: #ffb3d0; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 0.9em; }
  th { background: #1a1a2e; color: #ff6b9d; padding: 10px 8px; text-align: left; font-weight: 600; }
  td { padding: 8px; border-bottom: 1px solid #222; }
  tr:hover td { background: #1a1a1a; }
  .rank { color: #ff6b9d; font-weight: bold; text-align: center; width: 40px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  a { color: #7eb8ff; text-decoration: none; }
  a:hover { text-decoration: underline; color: #aad4ff; }
  .post-card {
    background: #151520; border: 1px solid #282838; border-radius: 8px;
    padding: 16px; margin-bottom: 14px;
  }
  .post-card h3 { font-size: 1em; margin-bottom: 6px; }
  .post-card h3 a { color: #e0e0e0; }
  .post-card h3 a:hover { color: #ff6b9d; }
  .post-meta { color: #888; font-size: 0.8em; margin-bottom: 8px; }
  .post-body { color: #bbb; font-size: 0.85em; margin-bottom: 10px; white-space: pre-line; }
  .comments-section { border-top: 1px solid #282838; padding-top: 10px; margin-top: 10px; }
  .comments-section h4 { color: #aaa; font-size: 0.8em; margin-bottom: 6px; }
  .comment-item {
    background: #1a1a28; border-radius: 6px; padding: 8px 12px;
    margin-bottom: 6px; font-size: 0.82em; color: #ccc;
  }
  .tag { display: inline-block; background: #2a1a30; color: #ff6b9d; padding: 2px 8px; border-radius: 10px; font-size: 0.75em; margin-right: 4px; }
  .all-posts-table a { display: block; max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 700px) {
    body { padding: 10px; }
    table { font-size: 0.8em; }
    .post-card { padding: 12px; }
  }
</style>
</head>
<body>

<h1>theqoo /akb48 리포트</h1>
<div class="subtitle">생성: ${dateLabel} · 최근 ${DAYS_BACK}일 · 총 ${posts.length}개 글</div>

<h2>AI 요약 (Gemini Flash)</h2>
<div class="summary-box">${summaryHtml}</div>

<h2>🔥 조회수 TOP 10</h2>
<table>
<tr><th>#</th><th>제목</th><th class="num">조회수</th><th class="num">댓글</th><th>날짜</th></tr>
${top10Views.map((p, i) => `<tr>
  <td class="rank">${i + 1}</td>
  <td><a href="${escapeHtml(p.url)}" target="_blank">${escapeHtml(p.title)}</a></td>
  <td class="num">${p.views.toLocaleString()}</td>
  <td class="num">${p.comments}</td>
  <td>${escapeHtml(p.date)}</td>
</tr>`).join('\n')}
</table>

<h2>💬 댓글수 TOP 10</h2>
<table>
<tr><th>#</th><th>제목</th><th class="num">댓글</th><th class="num">조회수</th><th>날짜</th></tr>
${top10Comments.map((p, i) => `<tr>
  <td class="rank">${i + 1}</td>
  <td><a href="${escapeHtml(p.url)}" target="_blank">${escapeHtml(p.title)}</a></td>
  <td class="num">${p.comments}</td>
  <td class="num">${p.views.toLocaleString()}</td>
  <td>${escapeHtml(p.date)}</td>
</tr>`).join('\n')}
</table>

<h2>📝 주요 글 상세 (조회수 상위)</h2>
${top10Views.map(p => {
  const bodyPreview = p.content ? escapeHtml(p.content.substring(0, 300)) + (p.content.length > 300 ? '...' : '') : '(본문 없음)';
  const commentsHtml = (p.topComments || []).length > 0
    ? `<div class="comments-section">
        <h4>💬 주요 댓글</h4>
        ${p.topComments.slice(0, 5).map(c => `<div class="comment-item">${escapeHtml(c)}</div>`).join('\n')}
       </div>`
    : '';
  return `<div class="post-card">
  <h3><a href="${escapeHtml(p.url)}" target="_blank">${escapeHtml(p.title)}</a></h3>
  <div class="post-meta">조회 ${p.views.toLocaleString()} · 댓글 ${p.comments} · ${escapeHtml(p.date)}</div>
  <div class="post-body">${bodyPreview}</div>
  ${commentsHtml}
</div>`;
}).join('\n')}

<h2>📋 전체 글 목록</h2>
<table class="all-posts-table">
<tr><th>#</th><th>제목</th><th class="num">조회</th><th class="num">댓글</th><th>날짜</th></tr>
${posts.map((p, i) => `<tr>
  <td>${i + 1}</td>
  <td><a href="${escapeHtml(p.url)}" target="_blank">${escapeHtml(p.title)}</a></td>
  <td class="num">${p.views.toLocaleString()}</td>
  <td class="num">${p.comments}</td>
  <td>${escapeHtml(p.date)}</td>
</tr>`).join('\n')}
</table>

<div style="color:#555; font-size:0.75em; margin-top:40px; text-align:center;">
  Generated by theqoo/akb48 scraper · ${new Date().toISOString()}
</div>

</body>
</html>`;

  return { html, dateLabel };
}

async function main() {
  console.log('=== theqoo /akb48 크롤러 시작 ===\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await login(page);
    const posts = await collectPostList(page);

    if (posts.length === 0) {
      console.log('수집된 글이 없습니다.');
      return;
    }

    await collectPostContents(page, posts);

    // Gemini 요약
    const geminiSummary = await summarizeWithGemini(posts);

    // HTML 리포트 생성
    const { html, dateLabel } = generateHtmlReport(posts, geminiSummary);

    const outputDir = path.join(process.cwd(), 'output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const outputPath = path.join(outputDir, `report_${dateLabel}.html`);
    fs.writeFileSync(outputPath, html, 'utf-8');

    // GitHub Pages용 docs/index.html 업데이트
    const docsDir = path.join(process.cwd(), 'docs');
    if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'index.html'), html, 'utf-8');

    console.log(`\n=== 리포트 저장: ${outputPath} ===`);
    console.log(`GitHub Pages: docs/index.html 업데이트 완료`);
  } catch (err) {
    console.error('오류 발생:', err);
  } finally {
    await browser.close();
  }
}

main();

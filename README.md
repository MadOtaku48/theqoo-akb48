# theqoo/akb48 크롤러

theqoo.net/akb48 게시판의 최근 글을 자동 크롤링하여 AI 요약 리포트를 생성하고 GitHub Pages에 배포하는 도구.

## 라이브 리포트

**https://madotaku48.github.io/theqoo-akb48/**

매일 오전 9시 자동 업데이트.

## 기능

- **자동 크롤링** — Playwright 기반 theqoo.net 로그인 + 게시글/댓글 수집
- **AI 요약** — Gemini 2.5 Flash API로 전체 트렌드, 토픽별 분석, 팬덤 감성 분석
- **HTML 리포트** — 조회수/댓글수 TOP 10, 주요 글 상세, 전체 글 목록 (원글 링크 포함)
- **증분 크롤링** — `posts_cache.json`에 수집 결과 캐싱, 재실행 시 새 글만 크롤링
- **자동 배포** — crontab으로 매일 실행 → GitHub Pages 자동 업데이트

## 프로젝트 구조

```
theqoo/
├── .env                  # 로그인 자격증명 + Gemini API 키
├── .gitignore
├── package.json
├── scraper.mjs           # 메인 크롤러 스크립트
├── docs/
│   └── index.html        # GitHub Pages 배포용 (자동 생성)
└── output/
    ├── report_YYYY-MM-DD.html  # 날짜별 리포트
    ├── posts_cache.json        # 크롤링 캐시
    └── cron.log                # crontab 실행 로그
```

## 설치

```bash
npm install
npx playwright install chromium
```

## 환경 변수 (.env)

```
THEQOO_ID=your_id
THEQOO_PW=your_password
GEMINI_API_KEY=your_gemini_api_key
```

## 실행

```bash
node scraper.mjs
```

## 실행 흐름

```
로그인 → 글 목록 수집 (최근 3일) → 본문+댓글 수집 (캐시 활용) → Gemini AI 요약 → HTML 리포트 생성 → docs/index.html 업데이트
```

## crontab (자동 실행)

매일 오전 9시 실행 + GitHub Pages 자동 배포:

```
0 9 * * * cd /Users/suknamgoong/theqoo && node scraper.mjs >> output/cron.log 2>&1 && git add docs/index.html && git commit -m "Update report $(date +%Y-%m-%d)" && git push origin main >> output/cron.log 2>&1
```

## 설정 변경

| 항목 | 위치 | 기본값 |
|------|------|--------|
| 수집 기간 | `scraper.mjs` → `DAYS_BACK` | 3일 |
| 요청 딜레이 | `scraper.mjs` → `DELAY_MS` | 1~2초 |
| AI 모델 | `scraper.mjs` → Gemini API URL | gemini-2.5-flash |
| 요약 토큰 | `scraper.mjs` → `maxOutputTokens` | 8192 |

## 기술 스택

- **Node.js** + ES Modules
- **Playwright** — 헤드리스 브라우저 크롤링
- **Gemini 2.5 Flash API** — AI 요약 생성
- **GitHub Pages** — 정적 사이트 배포
- **crontab** — 스케줄링

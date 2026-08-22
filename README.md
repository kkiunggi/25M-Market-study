# 25M Markets Live

S&T 준비를 위한 25분 데일리 시장 훈련 웹앱입니다.

## 연결 데이터
- US 2Y / US 10Y: FRED
- 한국 국고채 3Y / 10Y: BOK ECOS
- USD/KRW: Frankfurter
- USD Broad, S&P 500, Nasdaq, Brent, VIX: FRED
- News: GDELT

무료 공개 데이터 기반이라 초단위 실시간 호가가 아니라 공식/일별 업데이트 중심입니다.

## 실행
```bash
npm install
npm start
```

## Render 배포
- Build Command: `npm install`
- Start Command: `npm start`
- Node 18+

AI 피드백을 쓰려면 Render의 Environment Variables에 `OPENAI_API_KEY`를 추가하세요. 선택적으로 `OPENAI_MODEL`을 지정할 수 있으며 기본값은 `gpt-5.4`입니다.

API 키를 GitHub 코드에 직접 넣지 마세요.

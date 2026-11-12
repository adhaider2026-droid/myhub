// اختبار محرك الريلز محليًا: صورتان → فيديو 9:16 بحركة كاميرا وانتقال
const path = require('path');
const merge = require('../lib/merge');

(async () => {
  const out = path.join(__dirname, '..', '.tmp-fixtures', 'reel-test.mp4');
  const result = await merge.slideshowFiles(
    [
      path.join(__dirname, '..', '.tmp-fixtures', 't1.jpg'),
      path.join(__dirname, '..', '.tmp-fixtures', 't2.jpg'),
    ],
    out,
    { sceneDuration: 4, transition: 'fade', width: 360, height: 640, preset: 'veryfast' }
  );
  console.log('RESULT', JSON.stringify(result));
})().catch((e) => {
  console.error('FAILED:', e.statusCode || '', e.message);
  process.exit(1);
});

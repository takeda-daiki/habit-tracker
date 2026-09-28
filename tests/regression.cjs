// Run: node tests/regression.cjs
// Requires Playwright (or set PLAYWRIGHT_MODULE to its installed package path).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  new Function(source.match(/<script>([\s\S]*?)<\/script>/)[1]);
  // Expose functions only in this isolated test server, never in the shipped app.
  const instrumented = source.replace('  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));\n  renderHome();',
    '  window.testApp={aggregateSeries,periodSeries,habitValue,exerciseSeries,normalizeData,chartHTML,shiftDate,weekStart};\n  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));\n  renderHome();');
  assert(instrumented.includes('window.testApp='));
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(instrumented);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true});
    const context = await browser.newContext({viewport: {width: 390, height: 844}, serviceWorkers: 'block'});
    await context.route('https://**/*', route => route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url);
    const today = await page.locator('#selectedDate').inputValue();
    await page.evaluate(today => {
      const data = JSON.parse(localStorage.getItem('habitTrackerV1'));
      data.exercises = [{id:'bench',name:'ベンチプレス',type:'weighted',muscleGroup:'胸'}, {id:'pushup',name:'腕立て伏せ',type:'bodyweight',muscleGroup:'腕'}];
      const days = [-200,-20,-10,-5,-3,-1];
      days.forEach((delta, i) => {
        const date = window.testApp.shiftDate(today, delta);
        data.workouts[date] = {bench:[{weight:50+i*2.5,reps:10},{weight:50+i*2.5,reps:8}],pushup:[{reps:15+i}]};
        data.entries[date] = {weight:60+i,career:30+i*10,sun:i%3,wake:{time:'07:10',baseline:'07:00'}};
        data.taskScores[date] = i%3;
      });
      data.entries[window.testApp.shiftDate(today,-2)] = {weight:'skipped',career:0,sun:0};
      localStorage.setItem('habitTrackerV1',JSON.stringify(data));
    }, today);
    await page.reload();
    const checkLayout = async label => {
      const size = await page.evaluate(() => ({viewport:innerWidth,page:document.documentElement.scrollWidth}));
      assert(size.page <= size.viewport, label + ': page overflows ' + JSON.stringify(size));
    };
    await checkLayout('home 390px');
    await page.locator('#datePrev').click();
    assert.notEqual(await page.locator('#selectedDate').inputValue(),today);
    await page.locator('#dateNext').click();
    assert.equal(await page.locator('#selectedDate').inputValue(),today);
    assert(await page.locator('#dateNext').isDisabled());
    // Native horizontal scrolling chooses a date without tapping a date button.
    await page.locator('#datePager').evaluate(el => {el.scrollLeft=0;});
    await page.waitForFunction(today => document.querySelector('#selectedDate').value!==today,today);
    await page.waitForTimeout(400);
    const previous = await page.locator('#selectedDate').inputValue();
    await page.locator('#datePager').evaluate(el => {el.scrollLeft=el.clientWidth*2;});
    await page.waitForFunction(previous => document.querySelector('#selectedDate').value!==previous,previous);
    assert.equal(await page.locator('#selectedDate').inputValue(),today);

    const aggregation = await page.evaluate(() => {
      const t=window.testApp,series=[{date:'2026-08-31',y:10},{date:'2026-09-01',y:20},{date:'2026-09-02',y:null},{date:'2026-09-03',y:0}];
      return {sum:t.aggregateSeries(series,'week'),mean:t.aggregateSeries(series,'week','mean'),months:t.aggregateSeries(series,'month'),old:t.normalizeData({}).workoutRest,leap:t.shiftDate('2024-03-01',-1),year:t.weekStart('2026-01-01')};
    });
    assert.equal(aggregation.sum[0].y,30);assert.equal(aggregation.mean[0].y,10);
    assert.deepEqual(aggregation.months.map(p=>p.y),[10,20]);assert.deepEqual(aggregation.old,{});
    assert.equal(aggregation.leap,'2024-02-29');assert.equal(aggregation.year,'2025-12-29');
    for (const period of ['週別','月別','日別']) {
      await page.locator('#overviewPeriods').getByRole('button',{name:period,exact:true}).click();
      assert(await page.locator('#totalTimeChart circle').count()>0);
      assert(await page.locator('#totalScoreChart circle').count()>0);
    }
    await page.locator('#habitList .row').filter({hasText:'体重'}).click();
    assert.equal(await page.locator('#detailChart circle').count(),5);
    assert.equal(await page.locator('#detailChart polyline').count(),1);
    assert.equal((await page.locator('#detailChart polyline').getAttribute('points')).split(' ').length,5);
    await page.getByRole('button',{name:'測らなかった',exact:true}).click();
    assert.equal(await page.evaluate(date=>JSON.parse(localStorage.getItem('habitTrackerV1')).entries[date].weight,today),'skipped');
    await page.reload();
    assert.match(await page.locator('#habitList .row').filter({hasText:'体重'}).innerText(),/測らなかった/);
    await page.locator('#habitList .row').filter({hasText:'体重'}).click();
    await page.locator('#weightInput').fill('66.4');
    await page.locator('#detailEditor').getByRole('button',{name:'保存',exact:true}).click();
    assert.equal(await page.evaluate(date=>JSON.parse(localStorage.getItem('habitTrackerV1')).entries[date].weight,today),66.4);
    await checkLayout('weight');
    await page.locator('#detailBack').click();

    for (const name of ['朝陽','進路設計','起床時間','To do']) {
      await page.locator('#habitList strong').getByText(name,{exact:true}).click();
      assert(await page.locator('#detailWeekChart circle').count()>0,name+' weekly');
      assert(await page.locator('#detailMonthChart circle').count()>0,name+' monthly');
      await checkLayout(name);
      await page.locator('#detailBack').click();
    }
    await page.locator('#habitList strong').getByText('筋トレ',{exact:true}).click();
    await page.getByRole('button',{name:'休憩する',exact:true}).click();
    assert.equal(await page.locator('#muscleHistory tbody tr').count(),6);
    assert.equal(await page.locator('#muscleHistory thead th').count(),8);
    assert.equal(await page.locator('#muscleHistory tbody tr').first().locator('td').first().innerText(),'休');
    await page.reload();
    assert.match(await page.locator('#habitList .row').filter({hasText:'筋トレ'}).innerText(),/休憩日/);
    await page.locator('#habitList strong').getByText('筋トレ',{exact:true}).click();
    await page.getByRole('button',{name:'休憩日を取り消す',exact:true}).click();
    await page.getByRole('button',{name:'休憩する',exact:true}).click();
    await page.locator('#exerciseList .row').filter({hasText:'ベンチプレス'}).click();
    await checkLayout('exercise 390px');
    assert.equal(await page.locator('#exerciseChart circle').count(),6,'records older than 120 days retained');
    assert.equal(await page.locator('#exerciseChart .history-table tbody tr').count(),5);
    assert.equal(await page.locator('#exerciseMaxChart .point-label').count(),10);
    const xs=await page.locator('#exerciseChart circle').evaluateAll(els=>els.map(el=>Number(el.getAttribute('cx'))));
    assert(xs.slice(1).every((x,i)=>Math.abs((x-xs[i])-(xs[1]-xs[0]))<.001),'equal workout spacing');
    const axes=await page.locator('#exerciseChart svg text').allTextContents();
    assert.equal(axes[0],axes[1],'both Y axes match');
    const scroll=await page.locator('#exerciseChart .chart-wrap').evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));
    assert(scroll.scroll>scroll.client,'graph has its own scroll area');
    await page.locator('#sets input').nth(0).fill('70');await page.locator('#sets input').nth(1).fill('10');
    await page.locator('#saveSets').click();
    assert.equal(await page.evaluate(date=>JSON.parse(localStorage.getItem('habitTrackerV1')).workoutRest[date],today),undefined);
    await page.waitForFunction(()=>{const el=document.querySelector('#exerciseChart .chart-wrap');return el.scrollLeft>=el.scrollWidth-el.clientWidth-1;});
    if(process.env.SCREENSHOT_PATH)await page.screenshot({path:process.env.SCREENSHOT_PATH,fullPage:true});
    for(const width of [320,768,1440]) {await page.setViewportSize({width,height:900});await checkLayout('exercise '+width);}
    await page.setViewportSize({width:390,height:844});
    await page.locator('#exerciseBack').click();
    await page.locator('#exerciseList .row').filter({hasText:'腕立て伏せ'}).click();
    assert.match(await page.locator('#exerciseChartTitle').innerText(),/合計回数/);
    assert.match(await page.locator('#exerciseMaxChart .point-label').first().textContent(),/回/);
    await page.locator('#exerciseBack').click();await page.locator('#workoutBack').click();
    for(const width of [320,768,1440]) {await page.setViewportSize({width,height:900});await checkLayout('home '+width);}
    assert.deepEqual(errors,[]);
    console.log('PASS: date navigation, aggregation, missing values, persistence, rest days, workout history, both axes, mobile/desktop layout, and bodyweight records.');
  } finally {
    if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});

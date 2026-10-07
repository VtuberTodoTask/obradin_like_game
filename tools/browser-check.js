// 作者による操作検査。正解を知らない人の推理プレイとは区別する。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { load } = require('./load');
const { responseFor } = require('./narration-stub');
const A = load();
async function main() {
  const browser = await chromium.launch({ channel: process.env.ASARIYA_BROWSER || 'chrome', headless: true });
  fs.mkdirSync(path.join(__dirname, '../test-results'), { recursive: true });
  const rows = [];
  try {
    const emptySeed = Array.from({ length: 100 }, (_, i) => i + 1).find((seed) => A.Generator.generate(seed).scenario.current_state.survivors.length === 0);
    for (const [seed, opts] of [[730, { fixed: true }], [1, {}], [2, {}], [3, {}], [emptySeed, {}]]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addInitScript(() => Object.defineProperty(window, 'ASARIYA_LOCAL', {
        configurable: false, get: () => ({ openai: { apiKey: '', autoNarrate: false } }), set: () => {},
      }));
      await context.route(/^https?:/, (route) => route.abort());
      const page = await context.newPage(), errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('dialog', (dialog) => dialog.accept());
      const url = pathToFileURL(path.join(__dirname, '../index.html')).href + (opts.fixed ? '?scenario=fixed' : `?seed=${seed}`);
      const { scenario: sc } = A.Generator.generate(seed, opts);
      await page.goto(url); await page.waitForSelector('#viewer .doc-title');
      const unknown = sc.residents.filter((r) => !sc.initial_known_ids.includes(r.id));
      let visible = await page.locator('body').innerText();
      for (const r of unknown) { assert.ok(!visible.includes(r.name)); assert.ok(!visible.includes(r.id)); }
      await page.locator('#btnDev').click();
      assert.equal(await page.locator('#devDlg').evaluate((el) => el.open), true);
      assert.ok((await page.locator('#devBody').innerText()).includes('本文の掲載 PASS'));
      assert.ok((await page.locator('#devLLMSummary').innerText()).includes('未実施'));
      await page.locator('#devReachSteps summary').click();
      const stepRows = page.locator('#devReachSteps tbody tr'), reach = A.Verifier.verify(sc).reach;
      assert.equal(await stepRows.count(), reach.steps.length);
      for (let i = 0; i < reach.steps.length; i++) for (const id of reach.steps[i]) {
        const text = await stepRows.nth(i).innerText();
        assert.ok(text.includes(id)); assert.ok(text.includes(sc.residents.find((r) => r.id === id).name));
      }
      await page.locator('#devDlg [data-close]').click();
      await page.locator('[data-doc="dialogue"]').click();
      const actor = sc.residents[2], witness = sc.residents[3];
      await page.locator(`#viewer [data-tok="${actor.token}"]`).first().click();
      await page.locator('[data-draft="nickname"]').fill('配給の人');
      await page.locator('[data-draft="district"]').fill('C');
      await page.locator('[data-draft="order"]').fill('03');
      await page.locator('[data-draft="job"]').fill(String(actor.job_code));
      await page.locator('#memo').fill('発言と操作記録を比較する');
      await page.locator('#viewer [data-pin]').nth(0).click();
      await page.locator('#viewer [data-pin]').nth(1).click();
      await page.locator('#viewer [data-evidence]').first().click();
      await page.locator('[data-doc="timeline"]').click();
      assert.ok(await page.locator('#viewer > article.entry').count() > 0, '解読後も仮の名前の検索を保つ');
      assert.equal(await page.locator('.comparison .entry').count(), 2, await page.evaluate(() => JSON.stringify(Object.keys(localStorage).map((k) => JSON.parse(localStorage.getItem(k)).pins))));
      // 検索に未解読ログの時刻・場面・書き手が混ざらないこと。
      const initiallyReadable = A.Evidence.entries(sc, new Set(sc.initial_known_ids)).length;
      assert.equal(await page.locator('#viewer > article.entry').count(), initiallyReadable);
      visible = await page.locator('#viewer').innerText();
      for (const r of unknown) { assert.ok(!visible.includes(r.name)); assert.ok(!visible.includes(r.id)); }
      await page.locator('#timelineText').fill('配給の人'); await page.locator('#btnFilter').click();
      assert.ok(await page.locator('#viewer > article.entry').count() > 0);
      await page.reload(); await page.waitForSelector('#viewer .doc-title');
      assert.equal(await page.locator('[data-draft="nickname"]').inputValue(), '配給の人');
      assert.equal(await page.locator('#memo').inputValue(), '発言と操作記録を比較する');
      assert.ok((await page.locator('#tokDetail').innerText()).includes('保存した根拠'));
      await page.locator('[data-doc="timeline"]').click();
      assert.equal(await page.locator('.comparison .entry').count(), 2);
      assert.equal(await page.locator('#timelineText').inputValue(), '配給の人');
      // 実際の認証成功は、選択中トークンの推測との一致を意味しない。
      await page.locator('#idInput').fill(witness.id); await page.locator('#unlockForm button').click();
      assert.ok((await page.locator('#termLog').innerText()).includes('別のトークン'));
      for (const r of unknown.filter((r) => r.id !== witness.id)) {
        await page.locator('#idInput').fill(r.id); await page.locator('#unlockForm button').click();
      }
      await page.locator('[data-doc="timeline"]').click();
      assert.ok(await page.locator('#viewer > article.entry').count() > 0, '解読後も仮の名前で検索できる');
      if (opts.fixed) {
        await page.screenshot({ path: path.join(__dirname, '../test-results/fixed-desktop.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.locator('.comparison').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1);
        await page.screenshot({ path: path.join(__dirname, '../test-results/fixed-mobile.png'), fullPage: true });
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
      await page.locator('#btnAnswer').click();
      for (const r of sc.residents) {
        const tr = page.locator(`#answerTable tr[data-tok="${r.token}"]`), d = sc.deaths.find((d) => d.victim === r.id);
        await tr.locator('[data-f="status"]').selectOption(r.status);
        if (d) await tr.locator('[data-f="cause"]').selectOption(d.cause);
        if (d?.killer) await tr.locator('[data-f="killer"]').selectOption(sc.residents.find((r) => r.id === d.killer).token);
      }
      await page.locator('#btnConfirm').click();
      assert.equal(await page.locator('#answerTable tr.confirmed').count(), A.CONFIG.investigation.confirmGroup);
      await page.locator(`[name="verdict"][value="${sc.current_state.verdict.result}"]`).check();
      for (const reason of sc.current_state.verdict.reasons) await page.locator(`[name="reason"][value="${reason}"]`).check();
      await page.locator('#btnSubmit').click();
      assert.ok((await page.locator('#resultBody').innerText()).includes('完全解明'));
      assert.deepEqual(errors, []);
      rows.push({ seed, fixed: !!opts.fixed, pass: true, assertions: ['file起動', '漏洩の検査', '検証器表示', '人物下書き', '根拠保存', '比較', '時系列', '復元', '認証の食い違い', '途中確定', '最終提出'] });
      console.log(`${opts.fixed ? '固定' : 'ランダム'} ${seed}: PASS`);
      await context.close();
    }
    // v2の文章化がテンプレートに戻った後も、仕様エラーの詳細を表示できること。
    // ローカルのAPIキーを使わず、すべてのHTTP要求へスタブ応答を返す。
    const llmContext = await browser.newContext();
    await llmContext.addInitScript(() => Object.defineProperty(window, 'ASARIYA_LOCAL', {
      configurable: false, get: () => ({ openai: { apiKey: 'browser-test-stub', autoNarrate: false, maxRounds: 1 } }), set: () => {},
    }));
    let stubCalls = 0;
    const stubState = {}, stubOptions = { A, failFirst: 30 };
    await llmContext.route(/^https?:/, async (route) => {
      stubCalls++;
      const body = route.request().postDataJSON();
      const response = responseFor(body, stubOptions, stubState);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [
        { message: { content: JSON.stringify(response) } },
      ] }) });
    });
    const llmPage = await llmContext.newPage(), llmErrors = [];
    llmPage.on('pageerror', (e) => llmErrors.push(e.stack));
    await llmPage.goto(pathToFileURL(path.join(__dirname, '../index.html')).href + '?seed=2');
    await llmPage.waitForSelector('#viewer .doc-title');
    await llmPage.locator('#btnDev').click();
    await llmPage.locator('#devLLMRun').click();
    await llmPage.waitForFunction(() => !document.querySelector('#llmDlg').open);
    assert.ok(stubCalls > 0);
    await llmPage.locator('#btnDev').click();
    assert.deepEqual(llmErrors, []);
    assert.equal(await llmPage.locator('#devDlg').evaluate((el) => el.open), true);
    let summary = await llmPage.locator('#devLLMSummary').innerText();
    assert.ok(summary.includes('不合格あり')); assert.ok(summary.includes('復帰 30件'));
    assert.ok(summary.includes('LLM採用 20/50件'));
    assert.ok((await llmPage.locator('#devBody').innerText()).includes('表示中のシナリオ：PASS'));
    assert.ok((await llmPage.locator('#termLog').innerText()).includes('検証不合格 30 件'));
    assert.ok((await llmPage.locator('#narrInfo').innerText()).includes('検証不合格・復帰 30件'));
    await llmPage.locator('#devLLMDetails').click();
    const specDetails = llmPage.locator('#devLLMErrors');
    const items = specDetails.locator('.llm-fail > li');
    assert.equal(await items.count(), 30);
    assert.ok((await items.first().innerText()).includes('D01'));
    assert.ok((await items.first().innerText()).includes('必須：'));
    assert.ok((await items.first().innerText()).includes('missing_required_evidence'));
    await llmPage.screenshot({ path: path.join(__dirname, '../test-results/dev-llm-errors.png'), fullPage: true });
    const callsBeforeReload = stubCalls;
    await llmPage.reload(); await llmPage.waitForSelector('#viewer .doc-title');
    await llmPage.locator('#btnDev').click();
    summary = await llmPage.locator('#devLLMSummary').innerText();
    assert.ok(summary.includes('復帰 30件')); assert.ok(summary.includes('LLM採用 20/50件'));
    await llmPage.locator('#devLLMDetails').click();
    assert.equal(await llmPage.locator('#devLLMErrors .llm-fail > li').count(), 30);
    assert.ok((await llmPage.locator('#devLLMErrors').innerText()).includes('missing_required_evidence'));
    await llmPage.locator('#devLLMDiagnostics summary').first().click();
    assert.ok((await llmPage.locator('#devLLMDiagnostics').innerText()).includes('template'));
    assert.ok((await llmPage.locator('#termLog').innerText()).includes('検証不合格 30 件'));
    assert.ok((await llmPage.locator('#narrInfo').innerText()).includes('検証不合格・復帰 30件'));
    assert.equal(stubCalls, callsBeforeReload);
    assert.deepEqual(llmErrors, []);
    const generatedBeforeRecheck = stubState.generated, callsBeforeRecheck = stubCalls;
    await llmPage.locator('#devLLMDiagnostics details').first().evaluate((el) => { el.open = true; });
    await llmPage.locator('[data-recheck]').first().click();
    await llmPage.waitForFunction(() => document.querySelector('#termLog').textContent.includes('保存本文の再検査'));
    assert.equal(stubState.generated, generatedBeforeRecheck, '再検査ボタンは生成APIを呼ばない');
    assert.equal(stubCalls - callsBeforeRecheck, 2, '抽出・監査だけを呼ぶ');
    assert.ok((await llmPage.locator('#devLLMSummary').innerText()).includes('復帰 30件'));
    assert.deepEqual(llmErrors, []);
    await llmPage.locator('#devDlg').evaluate((el) => el.close());
    const normalText = await llmPage.locator('body').innerText(), normalScenario = A.Generator.generate(2).scenario;
    for (const r of normalScenario.residents) if (!normalScenario.initial_known_ids.includes(r.id)) {
      assert.ok(!normalText.includes(r.id), '全文採用後も未知IDをプレイ画面へ出さない');
      assert.ok(!normalText.includes(r.name), '全文採用後も未知の実名をプレイ画面へ出さない');
    }
    rows.push({ seed: 2, pass: true, transport: 'HTTP通信スタブ', assertions: ['シナリオPASSとLLM不合格30件を区別', '指摘の時刻・場面・必須観察', '再読み込み後の30件と理由の復元', '復元時の通信なし', '再生成なしの再検査ボタン', '全文採用後の未知人物非表示'] });
    console.log('LLM不合格30件の検証器・復元: PASS（通信スタブ）');
    await llmContext.close();

    const context = await browser.newContext(), page = await context.newPage();
    await context.addInitScript(() => Object.defineProperty(window, 'ASARIYA_LOCAL', {
      configurable: false, get: () => ({ openai: { apiKey: '', autoNarrate: false } }), set: () => {},
    }));
    await context.route(/^https?:/, (route) => route.abort());
    await page.goto(pathToFileURL(path.join(__dirname, '../index.html')).href + '?seed=1');
    await page.waitForSelector('#viewer .doc-title');
    const sc = A.Generator.generate(1).scenario, rejects = [];
    for (let order = 1; order <= sc.shelter.max_entry; order++) for (const job of A.CONFIG.jobs) {
      const id = `A-${String(order).padStart(2, '0')}-${job.code}`;
      if (!sc.residents.some((r) => r.id === id)) rejects.push(id);
    }
    for (const id of rejects.slice(0, 8)) { await page.locator('#idInput').fill(id); await page.locator('#unlockForm button').click(); }
    assert.equal(await page.locator('#resultDlg').evaluate((e) => e.open), false);
    assert.equal(await page.locator('#idInput').isDisabled(), true);
    await page.reload(); await page.waitForSelector('#viewer .doc-title');
    assert.equal(await page.locator('#idInput').isDisabled(), true);
    await page.locator('#btnReconnect').click(); assert.equal(await page.locator('#idInput').isDisabled(), false);
    await page.locator('#idInput').fill(rejects[0]); await page.locator('#unlockForm button').click();
    assert.equal(await page.locator('#alertMeter .on').count(), 0);
    rows.push({ seed: 1, pass: true, assertions: ['上限で真相を開示しない', '一時停止の復元', '再接続', '拒否済みIDは追加加算なし'] });
    await page.goto(pathToFileURL(path.join(__dirname, '../index.html')).href + '?seed=1&mode=hard');
    await page.waitForSelector('#viewer .doc-title');
    for (const id of rejects.slice(0, 8)) { await page.locator('#idInput').fill(id); await page.locator('#unlockForm button').click(); }
    assert.equal(await page.locator('#resultDlg').evaluate((e) => e.open), true);
    assert.equal(await page.locator('#btnReconnect').isVisible(), false);
    rows.push({ seed: 1, mode: 'hard', pass: true, assertions: ['ハードのみ上限で真相開示', '再接続なし'] });
    await context.close();
    fs.writeFileSync(path.join(__dirname, '../test-results/browser.json'), JSON.stringify({ browser: 'Chrome headless', transport: 'file://', humanBlindPlay: '未実施', rows }, null, 2));
  } finally { await browser.close(); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

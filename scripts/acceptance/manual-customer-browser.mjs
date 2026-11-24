/** Captures the real authenticated V4 customer UI after manual activation.
 * No synthetic network responses, hidden secrets, or physical print claims. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function customerBrowserAcceptance({customer,customerContext,origin,output,check}) {
  const captures=[]; const errors=[];
  const onError=error=>errors.push(String(error.message ?? error));
  customer.on('pageerror',onError);
  const views=[['home','/dashboard#home'],['printers','/dashboard#printers'],['agents','/dashboard#agents'],['activity','/dashboard#jobs'],['connect-odoo','/api-keys'],['connect-odoo-advanced','/api-keys'],['subscription','/billing'],['pricing','/pricing'],['setup','/onboarding'],['team','/team']];
  try {
    for(const locale of ['en','ar'])for(const width of [1440,390])for(const [slug,url] of views) {
      await customer.setViewportSize({width,height:width===390?844:1100});
      await customerContext.addCookies([{name:'__Host-yaseir_locale',value:locale,url:origin,secure:true,sameSite:'Lax'}]);
      await customer.evaluate(value=>localStorage.setItem('yaseir:locale',value),locale);
      await customer.goto(origin+url,{waitUntil:'networkidle'});
      await customer.waitForFunction(()=>!document.body.innerText.includes('Loading…')&&!document.body.innerText.includes('جارٍ التحميل…'));
      if(slug==='connect-odoo-advanced')await customer.locator('summary').filter({hasText:locale==='ar'?'إعدادات الاتصال المتقدمة':'Advanced connection settings'}).click();
      await customer.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await customer.locator('html').getAttribute('dir'),locale==='ar'?'rtl':'ltr');
      assert.equal(new URL(customer.url()).pathname,new URL(origin+url).pathname,`${slug} must render the actual destination, not a login/error redirect`);
      const text=await customer.locator('body').innerText();
      assert.ok(!/v4\.(?:onboarding|subscription|connection|pricing|experience|team)\./.test(text),`${slug} has untranslated keys`);
      assert.ok(!/Application error:|Internal Server Error|Unhandled Runtime Error/i.test(text),`${slug} has a runtime error`);
      if(slug==='subscription'||slug==='pricing')assert.ok(!/Stripe|past_due|trialing|incomplete_expired/i.test(text),'Manual customer subscription screens must not expose provider workflow');
      for(const input of await customer.locator('input[type="password"]').all())assert.equal(await input.inputValue(),'');
      const dimensions=await customer.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
      assert.ok(dimensions.scroll<=dimensions.width+2,`${slug}/${locale}/${width}: horizontal document overflow ${JSON.stringify(dimensions)}`);
      assert.equal(errors.length,0,`${slug}: ${errors.join('; ')}`);
      const file=`after-customer-${slug}-${locale}-${width}.png`;
      await customer.screenshot({path:path.join(output,file),fullPage:true});
      captures.push({file,path:url,locale,width,height:width===390?844:1100,documentWidth:dimensions.scroll,syntheticAccount:true,realBackend:true});
    }
    check(`${captures.length} real authenticated customer screenshots: dashboard, devices, activity, Connect Odoo, advanced controls, manual subscription, pricing, setup and team; Arabic/English desktop/mobile with no runtime errors or horizontal overflow`);
  } finally {
    customer.off('pageerror',onError);
    fs.writeFileSync(path.join(output,'customer-captures.json'),JSON.stringify({captures,errors,physicalPrintingVerified:false},null,2)+'\n');
  }
}

import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const out=path.resolve(process.env.STELLA_CWS_OUTPUT ?? `out/chrome-store-${Date.now()}`);
await mkdir(out,{recursive:false});
const browser=await chromium.launch({channel:'chrome',headless:true});
const exports=[];
try {
 const page=await browser.newPage({viewport:{width:1500,height:1000},deviceScaleFactor:1});
 await page.goto('http://localhost:3015/chrome-store',{waitUntil:'networkidle'});
 await page.waitForFunction(() => {
      const auras = [...document.querySelectorAll('[data-aura-ready]')];
      return auras.length > 0 && auras.every(aura => aura.getAttribute('data-aura-ready') === 'true');
    });
    await page.waitForFunction(()=>[...document.querySelectorAll('[data-brand-ready]')].every(e=>e.getAttribute('data-brand-ready')==='true'));
 await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.querySelectorAll<HTMLImageElement>('[data-cws-source]')].map(x=>x.decode()));});
 for (const [scene,width,height] of [['browser',1280,800],['checkout',1280,800],['small',440,280],['marquee',1400,560]] as const){
  const file=`${scene}.jpg`;const bytes=await page.locator(`[data-cws="${scene}"]`).screenshot({path:path.join(out,file),type:'jpeg',quality:98,animations:'disabled'});
  exports.push({file,width,height,sha256:createHash('sha256').update(bytes).digest('hex')});
 }
 const sources=await Promise.all(['browser','checkout','connected-popup'].map(async name=>{const file=`public/chrome-store/${name}.png`;return{file,sha256:createHash('sha256').update(await readFile(file)).digest('hex')}}));
 await writeFile(path.join(out,'manifest.json'),JSON.stringify({status:'review-required',exports,sources},null,2));console.log(out);
} finally {await browser.close()}

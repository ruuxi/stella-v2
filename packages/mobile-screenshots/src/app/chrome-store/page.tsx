import { StoreAura } from "@/components/StoreAura";
import { BrandCharacter } from "@/components/BrandCharacter";
import "./style.css";

export default function ChromeStore() {
 return <main className="cws-gallery">
  {['browser','checkout','small','marquee'].map((scene,index) => scene === 'marquee' ? <article key={scene} data-cws={scene} className="cws cws-marquee cws-og"><div className="cws-og-aura"><StoreAura index={0} count={1} className="cws-og-field"/></div><div className="cws-og-copy"><h1>Stella Browser</h1><p>Your browser, with Stella.</p></div></article> : <article key={scene} data-cws={scene} className={`cws cws-${scene}`}>
   <StoreAura index={index < 2 ? index : 0} count={index < 2 ? 2 : 1} className="cws-aura" />
   <div className="cws-brand">Stella <span>Browser</span></div>
   <BrandCharacter className="cws-mascot" eyeColor="#faf9f7" />
   <div className="cws-copy"><h1>{scene==='checkout'?<>From browsing<br/><em>to checkout.</em></>:<>Your browser.<br/><em>With Stella.</em></>}</h1>
    {scene!=='small' && <p>{scene==='checkout'?'You approve the purchase.':'Works with the Stella desktop app.'}</p>}
   </div>
   {scene!=='small' && <div className="cws-page"><img data-cws-source src={`/chrome-store/${scene==='checkout'?'checkout':'browser'}.png`} alt="Actual website from a Stella browser task"/><BrandCharacter shape="cursor" className="cws-cursor"/></div>}
   {scene!=='checkout' && <img data-cws-source className="cws-popup" src="/chrome-store/connected-popup.png" alt="Current Stella Browser extension, connected"/>}
  </article>)}
 </main>;
}

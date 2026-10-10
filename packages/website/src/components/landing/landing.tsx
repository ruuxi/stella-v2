import { Backdrop } from "./backdrop";
import { Finale, LandingFooter, OpenSourceAct } from "./closing";
import { ComputerAct } from "./computer-act";
import { DevicesAct } from "./devices-act";
import { landingFontVars } from "./fonts";
import { LandingHeader } from "./landing-header";
import { MakesAct } from "./makes-act";
import { Hero } from "./hero";
import { Metamorphosis } from "./metamorphosis";
import { ModelsAct } from "./models-act";
import { ParallelAct } from "./parallel-act";
import l from "./landing.module.css";

export function Landing() {
  return (
    <div className={`${l.root} ${landingFontVars}`} data-landing-root="" data-native-scroll="">
      <Backdrop />
      <LandingHeader />
      <main>
        <Hero />
        <Metamorphosis />
        <ComputerAct />
        <ParallelAct />
        <DevicesAct />
        <MakesAct />
        <ModelsAct />
        <OpenSourceAct />
        <Finale />
      </main>
      <LandingFooter />
    </div>
  );
}

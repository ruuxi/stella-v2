import { Backdrop } from "./backdrop";
import { Finale, LandingFooter, OpenSourceAct } from "./closing";
import { ComputerAct } from "./computer-act";
import { DevicesAct } from "./devices-act";
import { landingFontVars } from "./fonts";
import { LandingHeader } from "./landing-header";
import { MakesAct } from "./makes-act";
import { Metamorphosis } from "./metamorphosis";
import { ModelsAct } from "./models-act";
import { ParallelAct } from "./parallel-act";
import l from "./landing.module.css";

export function Landing() {
  return (
    <div className={`${l.root} ${landingFontVars}`} data-landing-root="">
      <Backdrop />
      <LandingHeader />
      <main>
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

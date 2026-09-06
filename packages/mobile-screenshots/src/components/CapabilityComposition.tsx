import { BrandCharacter } from "./BrandCharacter";

// Editorial capability symbols, outside the unchanged native screenshot.
const capabilities = [
  { id: "computer", label: "Computer use", color: "#505c61", path: "M3 4h26v18H3z M11 28h10 M16 22v6" },
  { id: "browse", label: "Browse the web", color: "#657cd0", path: "M4 7h24v19H4z M4 12h24 M8 9.5h.1 M11 9.5h.1" },
  { id: "code", label: "Build apps", color: "#8270a6", path: "m11 9-7 7 7 7m10-14 7 7-7 7m-3-17-4 20" },
  { id: "sheets", label: "Spreadsheets", color: "#43886c", path: "M6 3h15l5 5v21H6z M21 3v6h5 M10 14h12v11H10z M10 19h12 M16 14v11" },
  { id: "docs", label: "Documents", color: "#527db6", path: "M6 3h15l5 5v21H6z M21 3v6h5 M10 14h12 M10 19h12 M10 24h8" },
];

export function CapabilityComposition() {
  return <div className="capability-composition" aria-label="Browser use, app creation, spreadsheets and documents">
    {capabilities.map(({id,label,color,path}) => <div key={id} className={`capability capability-${id}`}>
      <span className="capability-icon" style={{background:color}}>
        <svg viewBox="0 0 32 32" fill="none" stroke="white" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path}/></svg>
      </span>
      <span>{label}</span>
    </div>)}
    <BrandCharacter shape="cursor" className="hero-cursor" />
  </div>;
}

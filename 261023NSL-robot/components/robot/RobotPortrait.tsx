export default function RobotPortrait({ moving = false, speaking = false }: { moving?: boolean; speaking?: boolean }) {
  return <div className={`robot-portrait ${moving ? 'is-moving' : ''} ${speaking ? 'is-speaking' : ''}`}>
    <svg viewBox="0 0 440 390" role="img" aria-label="담다 안내 로봇 일러스트">
      <defs><linearGradient id="body" x1="0" x2="1" y2="1"><stop stopColor="#fffef8"/><stop offset="1" stopColor="#dbe9df"/></linearGradient><linearGradient id="face" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#244c43"/><stop offset="1" stopColor="#102e2c"/></linearGradient></defs>
      <ellipse cx="220" cy="355" rx="114" ry="16" fill="#244c43" opacity=".09"/>
      <g className="robot-body">
        <rect x="170" y="316" width="30" height="39" rx="14" fill="#254c44"/><rect x="240" y="316" width="30" height="39" rx="14" fill="#254c44"/>
        <path d="M145 221Q132 275 149 324Q219 345 291 324Q309 275 295 221Z" fill="url(#body)" stroke="#bed0c5" strokeWidth="3"/>
        <path d="M142 236Q105 245 110 278" fill="none" stroke="#dce8df" strokeWidth="26" strokeLinecap="round"/>
        <path d="M298 236Q337 223 338 192" fill="none" stroke="#dce8df" strokeWidth="26" strokeLinecap="round"/>
        <ellipse cx="338" cy="185" rx="17" ry="21" fill="#f9fbf3" stroke="#bed0c5" strokeWidth="2"/>
        <rect x="153" y="230" width="134" height="17" rx="8" fill="#648d79"/>
        <rect x="171" y="263" width="98" height="44" rx="13" fill="#e9a85f"/>
        <text x="220" y="292" textAnchor="middle" fill="#253e32" fontWeight="800" fontFamily="system-ui,sans-serif" fontSize="22">담다</text>
        <path d="M220 83V59" stroke="#b4cabe" strokeWidth="8" strokeLinecap="round"/><circle cx="220" cy="50" r="10" fill="#e9a85f"/>
        <rect x="107" y="83" width="226" height="144" rx="64" fill="url(#body)" stroke="#bed0c5" strokeWidth="3"/>
        <rect x="127" y="103" width="186" height="105" rx="43" fill="url(#face)"/>
        <g fill="#c9f4cf"><rect x="165" y="132" width="17" height="30" rx="8"/><rect x="258" y="132" width="17" height="30" rx="8"/></g>
        <path d="M201 173Q220 188 239 173" fill="none" stroke="#c9f4cf" strokeWidth="5" strokeLinecap="round"/>
        <circle cx="151" cy="174" r="8" fill="#6aaf9e" opacity=".5"/><circle cx="289" cy="174" r="8" fill="#6aaf9e" opacity=".5"/>
      </g>
      <g className="robot-signal" fill="none" stroke="#789c80" strokeWidth="5" strokeLinecap="round"><path d="M362 114q16 20 0 39"/><path d="M378 103q26 32 0 62"/></g>
    </svg>
    <span className="portrait-caption">화면 속 안내 로봇 · 실제 기기 이동 없음</span>
  </div>;
}

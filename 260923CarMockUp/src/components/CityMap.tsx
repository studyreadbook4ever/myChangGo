import { useEffect, useId, useRef, useState } from "react";
import "./CityMap.css";

type Destination = "office" | "cafe" | "service" | "home";
type Point = readonly [number, number];

export interface CityMapProps {
  stage: "ready" | "driving" | "traffic" | "rerouted" | "arrived";
  progress: number;
  destination: Destination;
  parking: boolean;
  onPlaceSelect?: (id: Destination) => void;
}

// Presentation distances describe this deliberately schematic, fictional city.
export const ROUTE_DISTANCES: Record<
  Destination,
  { normal: number; rerouted: number }
> = {
  office: { normal: 3.2, rerouted: 3.8 },
  cafe: { normal: 1.8, rerouted: 2.2 },
  service: { normal: 2.4, rerouted: 2.8 },
  home: { normal: 1.2, rerouted: 1.6 },
};

const COMMON: Point[] = [
  [185, 595],
  [325, 595],
  [325, 445],
];
const ROUTES: Record<Destination, { normal: Point[]; rerouted: Point[] }> = {
  office: {
    normal: [
      [325, 445],
      [325, 300],
      [710, 300],
      [710, 185],
    ],
    rerouted: [
      [325, 445],
      [510, 445],
      [510, 535],
      [710, 535],
      [710, 185],
    ],
  },
  cafe: {
    normal: [
      [325, 445],
      [325, 300],
      [510, 300],
    ],
    rerouted: [
      [325, 445],
      [510, 445],
      [510, 300],
    ],
  },
  service: {
    normal: [
      [325, 445],
      [510, 445],
      [510, 595],
      [710, 595],
    ],
    rerouted: [
      [325, 445],
      [325, 740],
      [710, 740],
      [710, 595],
    ],
  },
  home: {
    normal: [
      [325, 445],
      [325, 300],
      [185, 300],
    ],
    rerouted: [
      [325, 445],
      [125, 445],
      [125, 300],
      [185, 300],
    ],
  },
};

const PLACES: {
  id: Destination;
  x: number;
  y: number;
  name: string;
  type: string;
  width: number;
}[] = [
  {
    id: "office",
    x: 710,
    y: 185,
    name: "메이트 스튜디오",
    type: "다음 일정",
    width: 143,
  },
  {
    id: "cafe",
    x: 510,
    y: 300,
    name: "리버사이드 카페",
    type: "자주 가는 곳",
    width: 143,
  },
  {
    id: "service",
    x: 710,
    y: 595,
    name: "그린 오토케어",
    type: "차량 관리",
    width: 134,
  },
  {
    id: "home",
    x: 185,
    y: 300,
    name: "우리 집",
    type: "저장한 장소",
    width: 107,
  },
];

const ROAD_PATHS = [
  "M -900 185 H 1900",
  "M -900 300 H 780",
  "M -900 445 H 1900",
  "M -900 595 H 785",
  "M -900 740 H 1900",
  "M 125 -30 V 840",
  "M 325 -30 V 840",
  "M 510 185 V 840",
  "M 710 -30 V 840",
  "M 950 -30 V 840",
  "M 510 535 H 710",
  "M -75 -30 V 840",
  "M -275 -30 V 840",
  "M -475 -30 V 840",
  "M 1150 -30 V 840",
  "M 1350 -30 V 840",
  "M 950 300 H 1900",
  "M 950 595 H 1900",
];

function pointsToPath(points: Point[]) {
  return points
    .map(([x, y], index) => `${index ? "L" : "M"} ${x} ${y}`)
    .join(" ");
}

function locate(points: Point[], progress: number) {
  const lengths = points
    .slice(1)
    .map((point, i) =>
      Math.hypot(point[0] - points[i][0], point[1] - points[i][1]),
    );
  let remaining =
    lengths.reduce((total, length) => total + length, 0) *
    Math.max(0, Math.min(1, progress));
  for (let index = 0; index < lengths.length; index += 1) {
    if (remaining <= lengths[index] || index === lengths.length - 1) {
      const fraction = lengths[index] ? remaining / lengths[index] : 0;
      const from = points[index];
      const to = points[index + 1];
      return {
        x: from[0] + (to[0] - from[0]) * fraction,
        y: from[1] + (to[1] - from[1]) * fraction,
        angle:
          (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI + 90,
        traversed: [
          ...points.slice(0, index + 1),
          [
            from[0] + (to[0] - from[0]) * fraction,
            from[1] + (to[1] - from[1]) * fraction,
          ] as Point,
        ],
      };
    }
    remaining -= lengths[index];
  }
  return {
    x: points[0][0],
    y: points[0][1],
    angle: 90,
    traversed: [points[0]],
  };
}

/** The first 30% shares one exact path for every route and destination. */
export function getCarPosition(
  destination: Destination,
  progress: number,
  rerouted: boolean,
) {
  if (progress <= 0.3) return locate(COMMON, progress / 0.3);
  return locate(
    ROUTES[destination][rerouted ? "rerouted" : "normal"],
    (progress - 0.3) / 0.7,
  );
}

function Building({
  x,
  y,
  w,
  h,
  height = 15,
  tone = 0,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  height?: number;
  tone?: number;
}) {
  const dx = height * 0.58;
  const dy = height * 0.76;
  const roof = ["#e9e9e0", "#e2e6de", "#dce4df", "#efeae0"][tone % 4];
  return (
    <g className="city-map-building">
      <path
        d={`M ${x} ${y + h} h ${w} l ${dx + 11} ${dy + 8} h ${-w} Z`}
        fill="#677e6820"
      />
      <path
        d={`M ${x + w} ${y} v ${h} l ${dx} ${dy} v ${-h} Z`}
        fill="#c4cec3"
      />
      <path
        d={`M ${x} ${y + h} h ${w} l ${dx} ${dy} h ${-w} Z`}
        fill="#d2d8cc"
      />
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx="2"
        fill={roof}
        stroke="#d5dcd2"
        strokeWidth="1"
      />
      <path
        d={`M ${x + 5} ${y + h - 5} v ${-h + 10} h ${w - 10}`}
        fill="none"
        stroke="#f8f8f0"
        strokeWidth="1.5"
      />
      {w > 37 && h > 27 && (
        <rect
          x={x + 9}
          y={y + 8}
          width={w * 0.24}
          height={h * 0.25}
          rx="1.5"
          fill="#cdd8d1"
        />
      )}
      {height > 20 && (
        <path
          d={`M ${x + 6} ${y + h + 5} h ${w - 3} M ${x + 10} ${y + h + 10} h ${w - 3}`}
          stroke="#bdc9bf"
          strokeWidth="1.5"
        />
      )}
    </g>
  );
}

const BUILDINGS = (() => {
  const buildings: {
    x: number;
    y: number;
    w: number;
    h: number;
    height: number;
    tone: number;
  }[] = [];
  const blocks = [
    [25, 35, 80, 126],
    [150, 35, 150, 125],
    [535, 25, 148, 135],
    [737, 30, 58, 130],
    [25, 212, 70, 60],
    [153, 212, 145, 60],
    [350, 214, 135, 57],
    [540, 213, 140, 56],
    [743, 214, 50, 61],
    [28, 330, 72, 81],
    [151, 340, 66, 77],
    [350, 333, 130, 86],
    [737, 335, 43, 83],
    [28, 472, 72, 97],
    [153, 476, 145, 91],
    [350, 474, 134, 98],
    [539, 469, 132, 42],
    [745, 471, 38, 92],
    [24, 624, 72, 85],
    [152, 626, 145, 85],
    [350, 625, 134, 88],
    [535, 629, 144, 84],
    [742, 624, 40, 82],
    [24, 772, 73, 59],
    [153, 772, 145, 61],
    [351, 771, 130, 64],
    [540, 771, 132, 62],
    [974, 35, 72, 110],
    [974, 220, 73, 197],
    [974, 476, 75, 230],
  ];
  // Wider desktop viewports expose more of the same fictional neighborhood.
  [-450, -250, -48, 1065, 1175, 1375].forEach((x) => {
    [
      [30, 120],
      [214, 62],
      [332, 86],
      [477, 94],
      [629, 84],
      [775, 57],
    ].forEach(([y, height]) => {
      blocks.push([x, y, x === -48 || x === 1065 ? 52 : 145, height]);
    });
  });
  blocks.forEach(([bx, by, bw, bh], block) => {
    const cols = bw > 100 ? 3 : bw > 55 ? 2 : 1;
    const rows = bh > 100 ? 3 : bh > 65 ? 2 : 1;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const seed = block * 7 + row * 3 + col;
        buildings.push({
          x: bx + (col * bw) / cols,
          y: by + (row * bh) / rows,
          w: bw / cols - 12 - (seed % 5),
          h: bh / rows - 13 - (seed % 7),
          height: 9 + (seed % 17),
          tone: seed % 4,
        });
      }
    }
  });
  return buildings;
})();

function Tree({ x, y, size = 8 }: { x: number; y: number; size?: number }) {
  return (
    <g>
      <ellipse
        cx={x + 4}
        cy={y + 6}
        rx={size}
        ry={size * 0.67}
        fill="#506f5020"
      />
      <path
        d={`M ${x} ${y} v ${size + 3}`}
        stroke="#9aa886"
        strokeWidth="2.5"
      />
      <circle cx={x} cy={y - 2} r={size} fill="#a9bd95" />
      <circle
        cx={x - size * 0.2}
        cy={y - size * 0.35}
        r={size * 0.72}
        fill="#bacaa5"
      />
    </g>
  );
}

function PlaceIcon({ id }: { id: Destination }) {
  if (id === "home")
    return <path d="m -7 0 7-6 7 6 M -5 -1 v 8 h 10 v-8 M -1 7 v-4 h 3 v4" />;
  if (id === "cafe")
    return (
      <>
        <path d="M -6 -4 h 10 v7 a3 3 0 0 1-3 3 h-4 a3 3 0 0 1-3-3 Z M4-3 h2 a3 3 0 0 1 0 6 H4 M-7 9 H6" />
        <path d="M -3 -9 v2 M1-9 v2" />
      </>
    );
  if (id === "service")
    return (
      <path d="M 6-8 a5 5 0 0 0-6 6 l-7 7 a2 2 0 0 0 3 3 l7-7 a5 5 0 0 0 6-6 L5-1 2-4 Z" />
    );
  return (
    <>
      <rect x="-6" y="-8" width="12" height="16" rx="1" />
      <path d="M -2 -4 h1 M2-4 h1 M-2 0 h1 M2 0 h1 M-1 8 V4 h3 v4" />
    </>
  );
}

export default function CityMap({
  stage,
  progress,
  destination,
  parking,
  onPlaceSelect,
}: CityMapProps) {
  const uid = useId().replace(/:/g, "");
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 800 });
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const viewWidth = Math.max(1000, (800 * size.width) / size.height);
  const compactMap = size.width < 500;
  const markerScale = compactMap ? 1.6 : 1.35;
  const hasRerouted = stage === "rerouted" || stage === "arrived";
  const activeRoute = ROUTES[destination][hasRerouted ? "rerouted" : "normal"];
  const car = getCarPosition(
    destination,
    stage === "ready" ? 0 : progress,
    hasRerouted,
  );
  const fullPath = pointsToPath([...COMMON, ...activeRoute.slice(1)]);
  const alternatePath = pointsToPath(ROUTES[destination].rerouted);
  const traveled =
    progress <= 0.3
      ? pointsToPath(car.traversed)
      : pointsToPath([...COMMON, ...car.traversed.slice(1)]);
  const destinationPlace = PLACES.find((place) => place.id === destination)!;
  const trafficSegment = ROUTES[destination].normal.slice(0, 2);
  const traffic = locate(trafficSegment, 0.57);

  return (
    <div ref={container} className={`city-map city-map--${stage}`}>
      <svg
        className="city-map-svg"
        viewBox={`${(1000 - viewWidth) / 2} 0 ${viewWidth} 800`}
        preserveAspectRatio="xMidYMid slice"
        role="group"
        aria-label="메이트 시티 가상 지도. 우리 집, 오피스, 카페와 정비소를 선택할 수 있습니다."
      >
        <title>DriveMate · 메이트 시티</title>
        <desc>
          약 5km의 가상 동네입니다. 하드코딩된 도로 위로 차량이 이동하며 교통
          이벤트 이후 대체 경로를 표시합니다.
        </desc>
        <defs>
          <pattern
            id={`${uid}-grain`}
            width="28"
            height="28"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="4" cy="3" r="0.6" fill="#9cad9730" />
            <circle cx="19" cy="17" r="0.5" fill="#9cad9720" />
          </pattern>
          <filter
            id={`${uid}-pin-shadow`}
            x="-60%"
            y="-60%"
            width="220%"
            height="240%"
          >
            <feDropShadow
              dx="0"
              dy="4"
              stdDeviation="5"
              floodColor="#26483b"
              floodOpacity="0.15"
            />
          </filter>
          <filter
            id={`${uid}-car-shadow`}
            x="-100%"
            y="-100%"
            width="300%"
            height="300%"
          >
            <feDropShadow
              dx="0"
              dy="3"
              stdDeviation="5"
              floodColor="#183e30"
              floodOpacity="0.3"
            />
          </filter>
        </defs>
        <rect x="-1500" width="4000" height="800" fill="#e8eee2" />
        <rect x="-1500" width="4000" height="800" fill={`url(#${uid}-grain)`} />
        <g
          transform={`translate(500 400) scale(${zoom}) translate(-500 -400)`}
          className="city-map-world"
        >
          <path
            d="M 816 -40 C 765 95 916 160 835 295 C 758 424 825 465 808 590 C 792 715 851 743 828 840 L 1040 840 L 1040 -40 Z"
            fill="#dce7d5"
          />
          <path
            d="M 863 -40 C 810 88 953 167 876 295 C 799 423 869 483 849 598 C 829 711 894 773 870 840 L 939 840 C 960 749 899 704 922 593 C 945 477 874 428 947 302 C 1021 170 884 76 936 -40 Z"
            fill="#b9d8ce"
          />
          <path
            d="M 853 -40 C 800 88 943 167 866 295 C 789 423 859 483 839 598 C 819 711 884 773 860 840"
            fill="none"
            stroke="#f7f4dc"
            strokeWidth="5"
          />
          <path
            d="M 880 -40 C 827 88 970 167 893 295 C 816 423 886 483 866 598 C 846 711 911 773 887 840"
            fill="none"
            stroke="#cce3d8"
            strokeWidth="2"
            opacity="0.8"
          />
          <path
            d="M 837 -40 C 784 88 927 167 850 295 C 773 423 843 483 823 598 C 803 711 868 773 844 840"
            fill="none"
            stroke="#a5b995"
            strokeWidth="2"
            strokeDasharray="3 7"
          />

          <rect
            x="346"
            y="25"
            width="143"
            height="133"
            rx="19"
            fill="#cfdebc"
          />
          <path
            d="M 361 99 C 391 105 377 55 412 53 S 465 76 467 128"
            stroke="#eeeeda"
            strokeWidth="9"
            fill="none"
          />
          <ellipse cx="439" cy="101" rx="26" ry="20" fill="#bfd4b1" />
          <rect
            x="538"
            y="329"
            width="139"
            height="88"
            rx="15"
            fill="#cfdfbb"
          />
          <path
            d="M 551 398 L 577 347 L 602 397 L 650 350"
            fill="none"
            stroke="#eff0dc"
            strokeWidth="8"
            strokeLinejoin="round"
          />
          <rect x="225" y="332" width="68" height="85" rx="8" fill="#d5e1c2" />
          <rect x="548" y="551" width="135" height="23" rx="7" fill="#d1dfc1" />

          <g fill="none" strokeLinecap="round" strokeLinejoin="round">
            {ROAD_PATHS.map((path, index) => (
              <path
                key={`border-${index}`}
                d={path}
                stroke="#dce2d7"
                strokeWidth={index === 10 ? 22 : 37}
              />
            ))}
            {ROAD_PATHS.map((path, index) => (
              <path
                key={`road-${index}`}
                d={path}
                stroke="#fafaf3"
                strokeWidth={index === 10 ? 18 : 31}
              />
            ))}
            {ROAD_PATHS.slice(0, 10).map((path, index) => (
              <path
                key={`middle-${index}`}
                d={path}
                stroke="#e2e6db"
                strokeWidth="1"
                strokeDasharray="8 9"
              />
            ))}
          </g>
          <g stroke="#f9faf1" strokeWidth="3.5" strokeDasharray="3 3">
            <path d="M 301 427 h-8 M301 463 h-8 M 346 427 h8 M346 463 h8 M 490 282 h-8 M490 317 h-8 M733 575 h8 M733 615 h8" />
          </g>
          <g stroke="#c2ccc0" strokeWidth="2" fill="none">
            <path d="M 823 166 H 937 M823 204 H937 M 811 426 H 923 M811 464 H923 M 842 721 H 953 M842 759 H953" />
          </g>

          {BUILDINGS.map((building, index) => (
            <Building key={index} {...building} />
          ))}
          <Building x={568} y={83} w={55} h={59} height={37} tone={2} />
          <Building x={632} y={99} w={41} h={42} height={29} tone={2} />
          <g>
            {[
              [365, 45],
              [380, 132],
              [457, 44],
              [466, 147],
              [398, 108],
              [563, 342],
              [651, 403],
              [630, 337],
              [268, 346],
              [251, 401],
              [780, 60],
              [795, 112],
              [798, 257],
              [786, 394],
              [803, 500],
              [803, 547],
              [808, 643],
              [831, 684],
              [811, 326],
              [24, 155],
              [154, 161],
              [276, 155],
              [470, 270],
              [371, 594],
              [417, 593],
              [589, 560],
              [620, 560],
              [650, 560],
              [166, 730],
              [285, 730],
              [545, 731],
              [654, 730],
            ].map(([x, y], i) => (
              <Tree key={i} x={x} y={y} size={i < 10 ? 9 : 6} />
            ))}
          </g>

          <g
            className="city-map-labels"
            fill="#96a38e"
            fontSize="12"
            textAnchor="middle"
          >
            <text
              x="215"
              y="104"
              fontSize="15"
              fontWeight="600"
              letterSpacing="3"
            >
              메이트 타운
            </text>
            <text x="417" y="89" fontSize="11" fill="#82986f">
              센트럴 가든
            </text>
            <text x="604" y="391" fontSize="11" fill="#82986f">
              그린 파크
            </text>
            <text x="210" y="679" fontSize="12" letterSpacing="1">
              메이트 주거단지
            </text>
            <text
              x="913"
              y="532"
              transform="rotate(83 913 532)"
              fontSize="14"
              fill="#83aca0"
              letterSpacing="5"
            >
              메이트 리버
            </text>
            <text x="420" y="203" fontSize="10" letterSpacing="2">
              센트럴로
            </text>
            <text x="419" y="462" fontSize="10" letterSpacing="2">
              그린웨이
            </text>
            <text
              x="305"
              y="388"
              transform="rotate(-90 305 388)"
              fontSize="10"
              letterSpacing="2"
            >
              중앙대로
            </text>
            <text
              x="733"
              y="386"
              transform="rotate(-90 733 386)"
              fontSize="10"
              letterSpacing="2"
            >
              강변로
            </text>
            <text x="173" y="462" fontSize="10" letterSpacing="2">
              메이트로
            </text>
          </g>

          {stage === "traffic" && (
            <path
              d={alternatePath}
              fill="none"
              stroke="#719784"
              strokeWidth="7"
              strokeDasharray="8 9"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="city-map-alternate"
            />
          )}
          {hasRerouted && (
            <path
              d={pointsToPath(ROUTES[destination].normal)}
              fill="none"
              stroke="#b6beb0"
              strokeWidth="6"
              strokeDasharray="5 8"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.8"
            />
          )}
          <path
            d={fullPath}
            stroke="#dfebae"
            strokeWidth="15"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={fullPath}
            stroke="#214c3e"
            strokeWidth="8"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {progress > 0 && (
            <path
              d={traveled}
              fill="none"
              stroke="#9fbd94"
              strokeWidth="8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {stage === "traffic" && (
            <>
              <path
                d={pointsToPath(trafficSegment)}
                fill="none"
                stroke="#db7956"
                strokeWidth="8"
                strokeLinecap="round"
              />
              <g
                transform={`translate(${traffic.x - 24} ${traffic.y})`}
                filter={`url(#${uid}-pin-shadow)`}
              >
                <rect
                  x="-73"
                  y="-15"
                  width="68"
                  height="30"
                  rx="15"
                  fill="#fff7ef"
                  stroke="#efd1bd"
                />
                <circle
                  cx="-58"
                  cy="0"
                  r="4"
                  fill="#d97b54"
                  className="city-map-traffic-dot"
                />
                <text
                  x="-47"
                  y="4"
                  fontSize="11"
                  fill="#ae5938"
                  fontWeight="700"
                >
                  정체
                </text>
              </g>
            </>
          )}

          <g transform="translate(185 595)">
            <circle r="9" fill="#fffdf6" stroke="#254f40" strokeWidth="3" />
            <circle r="3.2" fill="#254f40" />
          </g>
          {PLACES.map((place) => {
            const selected = place.id === destination;
            const labelShift = compactMap
              ? place.id === "home"
                ? 20
                : place.id === "service"
                  ? -30
                  : 0
              : 0;
            return (
              <g
                key={place.id}
                transform={`translate(${place.x} ${place.y}) scale(${markerScale})`}
                className={`city-map-place${selected ? " city-map-place--selected" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={`${place.name}${selected ? ", 현재 목적지" : " 목적지로 선택"}`}
                onClick={() => onPlaceSelect?.(place.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onPlaceSelect?.(place.id);
                  }
                }}
              >
                <circle r="19" fill="transparent" />
                {selected && <circle r="18" fill="#cfdf7c" opacity="0.38" />}
                <circle
                  r="6"
                  fill={selected ? "#254d3e" : "#94aa8a"}
                  stroke="#fffdf5"
                  strokeWidth="3"
                />
                <g
                  transform={`translate(${-place.width / 2 + labelShift} -65)`}
                  filter={`url(#${uid}-pin-shadow)`}
                >
                  <path
                    d={`M ${place.width / 2 - labelShift - 6} 42 l 6 7 6-7`}
                    fill={selected ? "#214c3e" : "#fffffa"}
                  />
                  <rect
                    width={place.width}
                    height="43"
                    rx="12"
                    fill={selected ? "#214c3e" : "#fffffa"}
                    stroke={selected ? "#214c3e" : "#dfe6d9"}
                  />
                  <g
                    transform="translate(21 22)"
                    fill="none"
                    stroke={selected ? "#d9eb9b" : "#71836a"}
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <PlaceIcon id={place.id} />
                  </g>
                  <text
                    x="39"
                    y="19"
                    fill={selected ? "#f5f8e7" : "#445846"}
                    fontSize="11.5"
                    fontWeight="700"
                  >
                    {place.name}
                  </text>
                  <text
                    x="39"
                    y="32"
                    fill={selected ? "#adc7b4" : "#9aa68e"}
                    fontSize="8.5"
                  >
                    {selected ? "목적지" : place.type}
                  </text>
                </g>
              </g>
            );
          })}

          {parking ? (
            <g
              transform={`translate(${destinationPlace.x} ${destinationPlace.y}) scale(${markerScale})`}
              filter={`url(#${uid}-car-shadow)`}
              aria-label={`${destinationPlace.name}에 주차한 차량`}
            >
              <circle r="24" fill="#dcebb6" opacity="0.6" />
              <rect
                x="-17"
                y="-17"
                width="34"
                height="34"
                rx="11"
                fill="#214c3e"
                stroke="#f4f7e8"
                strokeWidth="3"
              />
              <text
                textAnchor="middle"
                y="7"
                fontSize="22"
                fontWeight="700"
                fill="#e5eeae"
              >
                P
              </text>
            </g>
          ) : (
            <g
              transform={`translate(${car.x} ${car.y}) scale(${markerScale})`}
              className="city-map-car-position"
            >
              <circle
                className={
                  stage === "driving" || stage === "rerouted"
                    ? "city-map-car-pulse"
                    : ""
                }
                r="28"
                fill="#b9d975"
                opacity="0.26"
              />
              <circle r="20" fill="#d3e6a3" opacity="0.48" />
              <g
                transform={`rotate(${car.angle})`}
                filter={`url(#${uid}-car-shadow)`}
              >
                <rect
                  x="-11"
                  y="-19"
                  width="22"
                  height="38"
                  rx="8"
                  fill="#fbfcee"
                  stroke="#456448"
                  strokeWidth="1.7"
                />
                <path d="M-8 -9 Q0-15 8-9 L6-2 H-6 Z" fill="#46655b" />
                <path d="M-7 9 H7 L6 13 Q0 16-6 13 Z" fill="#91ac95" />
                <rect
                  x="-6"
                  y="0"
                  width="12"
                  height="7"
                  rx="2"
                  fill="#deebc7"
                />
                <path
                  d="M-10 -12 h4 M6-12 h4"
                  stroke="#f6f5cb"
                  strokeWidth="3"
                />
                <path
                  d="M-10 14 h3 M7 14 h3"
                  stroke="#ca8468"
                  strokeWidth="2"
                />
              </g>
            </g>
          )}
        </g>
      </svg>
      <div className="city-map-compass" aria-hidden="true">
        <span>N</span>
        <svg viewBox="0 0 24 28">
          <path d="m12 2 7 22-7-5-7 5Z" fill="#335744" />
          <path d="m12 2 7 22-7-5Z" fill="#b6c3a9" />
        </svg>
      </div>
      <div className="city-map-tools" aria-label="지도 보기 조절">
        <button
          type="button"
          aria-label="지도 확대"
          title="확대"
          disabled={zoom >= 1.6}
          onClick={() =>
            setZoom((value) => Math.min(1.6, +(value + 0.2).toFixed(1)))
          }
        >
          <svg viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="지도 축소"
          title="축소"
          disabled={zoom <= 1}
          onClick={() =>
            setZoom((value) => Math.max(1, +(value - 0.2).toFixed(1)))
          }
        >
          <svg viewBox="0 0 24 24">
            <path d="M5 12h14" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="지도 전체 경로 보기"
          title="전체 경로 보기"
          onClick={() => setZoom(1)}
        >
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="6" />
            <circle cx="12" cy="12" r="2" />
            <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
          </svg>
        </button>
      </div>
      <div className="city-map-attribution">
        <span className="city-map-scale" />
        가상 도시 · DEMO MAP
      </div>
    </div>
  );
}

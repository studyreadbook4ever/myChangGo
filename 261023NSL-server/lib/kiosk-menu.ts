import type { MenuItem } from "./kiosk-types";
const item = (id: string, names: string[], descriptions: string[], price: number, category: string, options: Partial<MenuItem> = {}): MenuItem => ({
  id,
  name: Object.fromEntries(['ko', 'en', 'ja', 'zh'].map((language, index) => [language, names[index]])) as MenuItem['name'],
  description: Object.fromEntries(['ko', 'en', 'ja', 'zh'].map((language, index) => [language, descriptions[index]])) as MenuItem['description'],
  price,
  category,
  image: `/api/menu/${id}/illustration.svg`,
  spicy: false,
  vegetarian: false,
  allergens: [],
  ...options,
});

export const initialMenu = [
  item('bibimbap', ['계절 비빔밥', 'Garden bibimbap', '季節のビビンバ', '时令蔬菜拌饭'],
    ['제철 나물과 채소, 고소한 참기름을 담은 한 그릇', 'Seasonal vegetables, steamed rice and sesame oil', '旬の野菜、ご飯、ごま油を合わせた一杯', '时令蔬菜配米饭和香油'], 11000, 'main', { vegetarian: true, allergens: ['sesame', 'soy', 'wheat'] }),
  item('bulgogi', ['직화 불고기 덮밥', 'Fire-grilled bulgogi', '炭火プルコギ丼', '炭烤牛肉盖饭'],
    ['달콤한 간장 양념의 소고기와 따뜻한 밥', 'Tender soy-marinated beef over warm rice', '甘辛い醤油だれの牛肉と温かいご飯', '酱香牛肉配热米饭'], 14000, 'main', { allergens: ['soy', 'wheat', 'sesame'] }),
  item('spicy-pork', ['매콤 제육 덮밥', 'Spicy pork rice bowl', '旨辛豚肉丼', '辣炒猪肉盖饭'],
    ['고추장 양념 돼지고기와 아삭한 채소', 'Gochujang pork with crisp vegetables', 'コチュジャン風味の豚肉と野菜', '韩式辣酱猪肉配爽脆蔬菜'], 12000, 'main', { spicy: true, allergens: ['soy', 'wheat', 'sesame'] }),
  item('chicken-katsu', ['바삭 치킨 가츠', 'Crispy chicken katsu', 'サクサクチキンカツ', '香脆鸡排饭'],
    ['바삭한 닭가슴살 커틀릿과 양배추 샐러드', 'Golden chicken cutlet, rice and cabbage slaw', '鶏むね肉のカツとキャベツサラダ', '金黄鸡排配米饭和卷心菜沙拉'], 13000, 'main', { allergens: ['wheat', 'egg', 'soy', 'milk'] }),
  item('udon', ['온기 가득 우동', 'Comfort udon', 'あったかうどん', '暖心乌冬面'],
    ['깊고 맑은 가쓰오 육수와 쫄깃한 면', 'Thick noodles in a clear bonito broth', 'かつおだしともちもちの麺', '柴鱼清汤配弹牙乌冬面'], 9500, 'main', { allergens: ['wheat', 'fish', 'soy'] }),
  item('mandu', ['노릇 군만두', 'Golden dumplings', '焼き餃子', '香煎饺子'],
    ['돼지고기와 채소를 채운 군만두 여섯 개', 'Six pan-fried pork and vegetable dumplings', '豚肉と野菜の焼き餃子6個', '六只猪肉蔬菜煎饺'], 6000, 'side', { allergens: ['wheat', 'soy', 'sesame'] }),
  item('iced-tea', ['제주 녹차', 'Jeju green tea', '済州緑茶', '济州绿茶'],
    ['가볍고 산뜻하게 우려낸 차가운 녹차', 'Light, refreshing cold-brewed green tea', 'すっきりとした冷たい緑茶', '清爽冷泡绿茶'], 3500, 'drink', { vegetarian: true }),
  item('yuzu-ade', ['유자 에이드', 'Sparkling yuzu', 'ゆずエード', '柚子气泡水'],
    ['향긋한 유자와 시원한 탄산의 만남', 'Fragrant yuzu with sparkling water', '香り豊かなゆずと炭酸水', '清香柚子与清凉气泡水'], 4500, 'drink', { vegetarian: true }),
];

export function menuIllustration(menuItem: MenuItem) {
  const colors: Record<string, string> = { bibimbap: '#477346', bulgogi: '#925a35', 'spicy-pork': '#b84f2c', 'chicken-katsu': '#c98d3b', udon: '#c2a261', mandu: '#b89b67', 'iced-tea': '#729465', 'yuzu-ade': '#d2a541' };
  const color = colors[menuItem.id] || '#729465';
  const drink = menuItem.category === 'drink';
  const contents = drink
    ? `<rect x="109" y="54" width="102" height="190" rx="24" fill="#fff" opacity=".7"/><path d="M119 106H201L194 220Q160 238 126 220Z" fill="${color}" opacity=".85"/><circle cx="165" cy="139" r="24" fill="#eee7a3" opacity=".8"/><path d="M184 30L170 183" stroke="#d9b38c" stroke-width="10" stroke-linecap="round"/>`
    : `<ellipse cx="160" cy="193" rx="111" ry="63" fill="#b8aa95" opacity=".2"/><ellipse cx="160" cy="164" rx="115" ry="78" fill="#fffdf7"/><ellipse cx="160" cy="160" rx="95" ry="60" fill="#e8dcc4"/><ellipse cx="160" cy="159" rx="81" ry="48" fill="${color}"/><path d="M98 143Q125 112 151 138M166 186Q194 150 219 169" stroke="#8baa59" stroke-width="18" stroke-linecap="round"/><path d="M119 175Q143 185 167 165M170 136L198 141" stroke="#edc17b" stroke-width="17" stroke-linecap="round"/><circle cx="159" cy="153" r="22" fill="#fffbec"/><circle cx="159" cy="153" r="12" fill="#e7ad43"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 280" role="img"><rect width="320" height="280" rx="24" fill="#eee9df"/>${contents}</svg>`;
}

import type { LocalSmallStep, PossibilityNode, PossibilityNodeState } from './livingFlow.ts';
import { initialWorldTiers } from './livingFlow.ts';
import type { VisualRecipe } from './model.ts';
import type { CanonicalBridgeTag } from './semanticBridgeVocabulary.ts';
import {
  PRODUCT_STATE_SCHEMA_VERSION,
  parsePersistedProductState,
  type BrowserStorage,
  type PersistedProductState,
  type ProductStateRepository,
} from './productState.ts';
import { INITIAL_WORLD_NODE_COUNT, TARGET_WORLD_NODE_COUNT, WORLD_EXPANSION_BATCH_SIZE } from './worldCapacity.ts';
import { WORLD_LAYOUT_VERSION, WORLD_SCHEMA_VERSION, type NodeDetail, type PersistedWorldSnapshotV1 } from './worldState.ts';
import { createIndexedDbWorldRepository, type WorldRepository } from './worldRepository.ts';

export const SAMPLE_MODE_QUERY = 'sample';
export const SAMPLE_PRODUCT_STATE_KEY = 'kurohige-map.public-sample.product-state.v1';
export const SAMPLE_WORLD_DATABASE_NAME = 'kurohige-map-world-public-sample';
export const SAMPLE_WORLD_ID = 'public-sample-world-120-v1';
export const SAMPLE_API_BLOCK_CODE = 'PUBLIC_SAMPLE_API_BLOCKED';

type SampleDomain = {
  category: string;
  resources: [string, string, string];
  connections: [string, string];
  helpedByTags: PossibilityNode['helpedByTags'];
  actions: Array<[title: string, description: string]>;
};

const domains: SampleDomain[] = [
  { category: '自然観察', resources: ['観察力', '記録', 'フィールド経験'], connections: ['自然', '市民科学'], helpedByTags: ['observation', 'field_research'], actions: [
    ['朝の野鳥観察会をひらく', '近所の公園で季節の鳥を見つけ、観察記録を持ち寄る。'],
    ['街路樹の季節マップをつくる', '花や実、葉の変化を歩いて記録し、地域の地図にまとめる。'],
    ['夜の昆虫ライト観察を試す', '灯りに集まる昆虫を安全に観察し、生態の違いを学ぶ。'],
    ['干潟の生きもの調査に参加する', '潮の満ち引きに合わせて生物を探し、保全データを残す。'],
    ['身近なコケの小さな図鑑を編む', '路地や石垣のコケを撮影し、特徴を比べる図鑑をつくる。'],
    ['川辺の水質観察を続ける', '水の透明度や周辺環境を定点で測り、変化を読み取る。'],
  ] },
  { category: '表現とアート', resources: ['表現力', '作品', '制作経験'], connections: ['創作', '発表'], helpedByTags: ['design', 'storytelling'], actions: [
    ['まちの小さなZINEを発行する', '取材と写真を一冊に編み、身近な魅力を手渡しで届ける。'],
    ['短編ストップモーションを制作する', '身近な素材を少しずつ動かし、短い映像作品に仕上げる。'],
    ['陶芸で日常の器をつくる', '土の手触りと焼成を学び、自分で使う器を形にする。'],
    ['音の風景を採集して作品にする', '街や自然の音を録り、ひとつのサウンド作品へ編集する。'],
    ['公共空間の光を撮る写真散歩', '時間で変わる光を探し、連作写真として発表する。'],
    ['小さな舞台美術を設計する', '物語の世界観を空間へ翻訳し、模型から舞台を組み立てる。'],
  ] },
  { category: '地域文化', resources: ['地域理解', '記録', '対話経験'], connections: ['地域', '文化継承'], helpedByTags: ['archival_research', 'community_storytelling'], actions: [
    ['商店街の聞き書きを残す', '店主の記憶を聞き、変わってきた街の物語を記録する。'],
    ['古写真をデジタル展示にする', '昔の写真を整理し、背景の物語と一緒に公開する。'],
    ['地域の祭りを裏方から支える', '準備や当日の運営に入り、受け継がれる工夫を学ぶ。'],
    ['郷土資料のやさしい案内を訳す', '地域資料を別の言語でも読める短いガイドへ整える。'],
    ['空き店舗で一日展示をひらく', '地域の作品や記録を集め、街角に短期間の展示をつくる。'],
    ['伝統工芸の工房で手ほどきを受ける', '職人の仕事を見て、基本工程を自分の手で体験する。'],
  ] },
  { category: '食と手仕事', resources: ['調理技術', 'レシピ', '運営経験'], connections: ['食', 'ものづくり'], helpedByTags: ['documentation', 'event_operations'], actions: [
    ['季節の発酵食品を仕込む', '素材と温度の変化を記録しながら発酵の基本を体験する。'],
    ['週末だけの小さなパン屋を試す', '少量のパンを焼き、値付けから販売までを一度通してみる。'],
    ['フードロス食材で試食会をひらく', '余りやすい食材を料理に変え、使い切る工夫を共有する。'],
    ['地域の家庭料理をレシピ集にする', '作り手に教わり、背景の物語と一緒にレシピを残す。'],
    ['コーヒー焙煎の違いを比べる', '焙煎度と味の変化を少量ずつ試し、自分の好みを探る。'],
    ['畑の収穫から一皿をつくる', '収穫、下ごしらえ、調理までをつなげて食の循環を知る。'],
  ] },
  { category: 'テクノロジー', resources: ['技術', 'プロトタイプ', '検証経験'], connections: ['デジタル', '社会課題'], helpedByTags: ['prototyping', 'data_analysis'], actions: [
    ['暮らしを助ける小さな道具を試作する', '困りごとを観察し、使える形のプロトタイプをつくる。'],
    ['地域オープンデータを地図にする', '公開データを整理し、街の特徴を見える地図へ変える。'],
    ['環境センサーを組み立てて測る', '温度や明るさを計測し、データの読み方を学ぶ。'],
    ['初心者向けアプリ制作会に参加する', '小さな機能を一つ完成させ、動くものを持ち帰る。'],
    ['思い出の資料を安全にデジタル化する', '画像化、整理、バックアップまでの流れを実践する。'],
    ['身近な人とプライバシーを学ぶ会を開く', '日常の設定を題材に、安全な情報の扱い方を話し合う。'],
  ] },
  { category: '学びと教育', resources: ['教える力', '教材', '学習経験'], connections: ['教育', '世代交流'], helpedByTags: ['education_facilitation', 'mentoring'], actions: [
    ['子ども向け科学クラブを手伝う', '実験の準備と対話を通して、問いを育てる場を支える。'],
    ['対話型の読書会をひらく', '一冊を入口に、違う読み方を安心して持ち寄る。'],
    ['難しいテーマを一枚教材にする', '情報を整理し、初めての人にも伝わる図解へまとめる。'],
    ['学び直しの伴走ボランティアをする', '相手のペースを尊重しながら、小さな目標を一緒に進める。'],
    ['博物館のセルフガイドをつくる', '展示の見どころを調べ、歩きながら読める案内にする。'],
    ['ことばの交換会を運営する', '教える側と学ぶ側を固定せず、互いの言語を試す場をつくる。'],
  ] },
  { category: 'ウェルビーイング', resources: ['習慣', '場づくり', '仲間'], connections: ['健康', '日常'], helpedByTags: ['community_facilitation', 'accessibility'], actions: [
    ['朝のゆっくり散歩会を続ける', '速さを競わず、街の変化に気づく短い散歩を習慣にする。'],
    ['誰でも参加できる軽スポーツを企画する', '体力差に配慮したルールで、楽しく体を動かす場をつくる。'],
    ['公園で呼吸とストレッチを試す', '屋外の空気を感じながら、無理のない動きを覚える。'],
    ['休み方を見つける一週間記録', '日々の気分と休息を記録し、自分に合う切り替え方を探る。'],
    ['静かな手仕事の集まりをひらく', '編み物やスケッチを持ち寄り、落ち着いて過ごせる時間をつくる。'],
    ['バリアフリーな外出ルートを歩く', '移動のしやすさを当事者の視点で確かめ、気づきを共有する。'],
  ] },
  { category: 'スポーツと冒険', resources: ['身体経験', '安全知識', '達成感'], connections: ['スポーツ', '屋外'], helpedByTags: ['observation', 'logistics'], actions: [
    ['里山の短いトレイルを歩く', '装備と天候を確認し、無理のないコースで自然を味わう。'],
    ['水辺で初めてのボートを漕ぐ', '安全講習を受け、仲間と呼吸を合わせて水上を進む。'],
    ['室内クライミングに挑戦する', '基本動作と安全確認を学び、自分に合う課題を登る。'],
    ['街なかオリエンテーリングを楽しむ', '地図と目印を頼りに、知らない道をチームで巡る。'],
    ['地域のファンランをつくる', '記録より交流を大切にした短いランイベントを運営する。'],
    ['自転車で水辺のルートを調べる', '休憩地点や危険箇所を確かめ、走りやすい道をまとめる。'],
  ] },
  { category: '音楽と舞台', resources: ['演奏経験', '発表機会', '制作物'], connections: ['音楽', '観客'], helpedByTags: ['audio_production', 'venue_operations'], actions: [
    ['小さなライブハウス企画を立ち上げる', '出演者と会場をつなぎ、近い距離で音楽を楽しむ夜をつくる。'],
    ['路上パフォーマンスの許可を調べて演じる', 'ルールと周囲への配慮を確認し、短い演目を届ける。'],
    ['声だけの短編ドラマを制作する', '脚本、収録、音響を組み合わせて耳で聴く物語をつくる。'],
    ['地域の踊りを習って発表する', '背景を教わりながら体を動かし、仲間と一つの演目を仕上げる。'],
    ['身近な音楽家のポッドキャストをつくる', '活動の原点を聞き、音と会話で魅力を伝える。'],
    ['初心者セッション会に参加する', '簡単な曲を合奏し、人と音を合わせる楽しさを知る。'],
  ] },
  { category: 'コミュニティ', resources: ['協働経験', 'つながり', '運営力'], connections: ['地域', '協働'], helpedByTags: ['community_facilitation', 'local_network'], actions: [
    ['まちの道具図書館をつくる', 'たまに使う道具を共有し、貸し借りの仕組みを試す。'],
    ['修理カフェを一日ひらく', '壊れた物を持ち寄り、直し方を教え合う場を運営する。'],
    ['世代を越えたお茶会を企画する', '話題と進行を工夫し、初対面でも話せる時間をつくる。'],
    ['地域の防災まち歩きを行う', '避難路や危険箇所を歩いて確認し、地図に残す。'],
    ['転入者向けの暮らしガイドを編む', '実際に困ったことを集め、使いやすい案内へまとめる。'],
    ['ボランティアの役割を整える', '参加しやすい作業単位と連絡方法を設計し、活動を支える。'],
  ] },
  { category: '科学と探究', resources: ['研究経験', 'データ', '問い'], connections: ['科学', '探究'], helpedByTags: ['experimentation', 'research_synthesis'], actions: [
    ['望遠鏡で月面を観察する', '機材の扱いを覚え、見えた地形をスケッチに残す。'],
    ['池の微生物を顕微鏡で見る', '採取から観察までを行い、小さな生態系に触れる。'],
    ['地域の気温を定点観測する', '複数地点を同じ条件で測り、場所による差を比べる。'],
    ['遺跡の公開調査を見学する', '調査員の説明を聞き、過去を読み解く方法を学ぶ。'],
    ['身近な疑問を一週間実験する', '仮説と記録方法を決め、毎日の結果から考える。'],
    ['市民研究の成果発表会へ出る', '調べた過程を短く整理し、質問を受けて次の問いを得る。'],
  ] },
  { category: '発信とメディア', resources: ['編集力', '発信物', '取材経験'], connections: ['メディア', '読者'], helpedByTags: ['publishing', 'content_planning'], actions: [
    ['働く人のインタビュー連載を始める', '仕事の実感を聞き、短い記事として継続的に届ける。'],
    ['AIで作った楽曲を動画で公開する', '制作過程を説明しながら、作品を一本の動画にまとめる。'],
    ['地域ニュースレターを月一で出す', '出来事を選び、読者が次に動ける情報として編集する。'],
    ['音声ドキュメンタリーをつくる', '現場音と証言を組み合わせ、耳で伝わる記録を制作する。'],
    ['公開データで小さな記事を書く', '数字を検証し、図と文章で地域の変化を伝える。'],
    ['本を紹介する共同冊子を編む', '複数人の推薦文を集め、一冊の読み物として仕上げる。'],
  ] },
  { category: '仕事と起業', resources: ['事業経験', '試作品', '顧客理解'], connections: ['仕事', '市場'], helpedByTags: ['project_management', 'brand_authority'], actions: [
    ['一日だけの小さな店を開く', '商品と売り場を用意し、実際の反応から改善点を探す。'],
    ['朝市で手づくり品を販売する', '価格、展示、会話を試し、自分の品の届け方を学ぶ。'],
    ['地域課題の協同プロジェクトを組む', '役割と意思決定を共有し、仲間と小さく事業を始める。'],
    ['暮らしの困りごとサービスを試す', '利用者へ聞き取りを行い、最小のサービスを提供してみる。'],
    ['作品制作のクラウドファンディングを設計する', '目的と返礼を整理し、応援が集まる伝え方を考える。'],
    ['地域素材のブランド物語をつくる', '作り手と背景を取材し、価値が伝わる言葉と見せ方にする。'],
  ] },
  { category: '旅と移動', resources: ['案内力', '旅程', '移動経験'], connections: ['旅', '交通'], helpedByTags: ['logistics', 'public_speaking'], actions: [
    ['路線バスの一日ガイドをつくる', '沿線の立ち寄り先を調べ、車窓と街を楽しむ旅程にする。'],
    ['小さな港から船旅に出る', '時刻と天候を調べ、海から地域を見る短い旅を計画する。'],
    ['車いす目線の観光ルートを確かめる', '段差や休憩場所を実地で確認し、利用できる情報にまとめる。'],
    ['物語を歩くまち案内をする', '土地の歴史を順路に沿って語り、参加者と街を読み直す。'],
    ['シェアサイクルで周遊コースを試す', '貸出地点と走りやすさを調べ、無理のないコースを作る。'],
    ['駅の乗り換え案内を改善提案する', '迷いやすい地点を観察し、伝わる案内の形を考える。'],
  ] },
  { category: '環境と循環', resources: ['環境知識', '実践記録', '改善案'], connections: ['環境', '循環'], helpedByTags: ['field_research', 'project_management'], actions: [
    ['地域の再生可能エネルギー施設を訪ねる', '設備と運営を見学し、暮らしとの接点を考える。'],
    ['家庭の生ごみで堆肥をつくる', '量と状態を記録し、無理なく続く循環を試す。'],
    ['種の交換ライブラリーを始める', '育てた種と情報を持ち寄り、地域に合う植物をつなぐ。'],
    ['生物多様性の小さな庭を育てる', '季節ごとの生きものを観察し、居場所になる植栽を試す。'],
    ['廃材を使ったアップサイクル作品をつくる', '捨てられる素材の特徴を生かし、新しい用途へ変える。'],
    ['川辺の外来植物除去に参加する', '専門家の説明を受け、環境回復の作業を体験する。'],
  ] },
  { category: 'クラフトと制作', resources: ['制作技術', '道具経験', '作品'], connections: ['工房', '手仕事'], helpedByTags: ['design', 'prototyping'], actions: [
    ['木工で小さなスツールをつくる', '測る、切る、組む工程を学び、使える家具を完成させる。'],
    ['草木染めで布の色を試す', '植物と媒染の違いを比べ、自然の色を布に残す。'],
    ['金属をたたいてアクセサリーをつくる', '道具の安全な使い方を学び、形と表面を仕上げる。'],
    ['手製本で自分のノートを綴じる', '紙を選び、折りと糸綴じで一冊のノートをつくる。'],
    ['3Dプリンターで交換部品を試作する', '寸法を測ってモデル化し、使えるまで形を調整する。'],
    ['身近な素材で小さな楽器をつくる', '音の出る仕組みを試し、演奏できる形へ仕上げる。'],
  ] },
  { category: 'ことばと国際交流', resources: ['言語経験', '異文化理解', '翻訳物'], connections: ['国際交流', 'ことば'], helpedByTags: ['translation', 'collaboration'], actions: [
    ['地域情報のやさしい日本語版をつくる', '難しい表現を見直し、必要な情報が届く文章へ整える。'],
    ['世界の家庭料理を教え合う会をひらく', '料理を通して暮らしの違いと共通点を語り合う。'],
    ['姉妹都市とのオンライン交流を企画する', '共通テーマを決め、離れた地域同士で作品や話を交換する。'],
    ['多言語の絵本読み聞かせに参加する', '音と絵を手がかりに、複数のことばを一緒に楽しむ。'],
    ['海外の地域文化を紹介する音声番組をつくる', '当事者に話を聞き、背景を丁寧に伝える番組にする。'],
    ['旅行者と地域住民の会話テーブルを運営する', '互いに質問できる進行を用意し、短い交流を生み出す。'],
  ] },
  { category: 'イベントと場づくり', resources: ['運営力', '企画書', '参加者理解'], connections: ['イベント', '参加'], helpedByTags: ['event_operations', 'community_facilitation'], actions: [
    ['小さな公開シンポジウムを企画する', '異なる立場の話し手を招き、問いを共有する場を設計する。'],
    ['手を動かすワークショップを開催する', '完成物と時間配分を決め、初めての人を案内する。'],
    ['一週間のポップアップ展示を運営する', '搬入から受付、撤収まで、短期展示の流れを実践する。'],
    ['地域カンファレンスの対話席をつくる', '聞くだけで終わらない小人数の対話をプログラムに入れる。'],
    ['社会課題ハッカソンへ参加する', '異なる専門の人と短期間で案を形にし、検証まで進める。'],
    ['本と人が出会う読書祭をひらく', '選書、紹介、交流を組み合わせた一日の催しをつくる。'],
  ] },
  { category: '農と生きもの', resources: ['飼育栽培経験', '観察記録', '季節感'], connections: ['農業', '生きもの'], helpedByTags: ['observation', 'documentation'], actions: [
    ['都市の小さな畑を一年育てる', '土づくりから収穫まで、季節に合わせた作業を続ける。'],
    ['養蜂家の仕事を見学する', '蜂の生態と安全な管理、地域の植物との関係を学ぶ。'],
    ['保護犬の散歩ボランティアをする', '施設のルールを守り、犬の様子を見ながら外の時間を支える。'],
    ['果樹園の摘果作業を手伝う', '実を選ぶ理由を教わり、収穫を支える季節作業を体験する。'],
    ['在来野菜の育て方を記録する', '土地に受け継がれた種を育て、作業と味の特徴を残す。'],
    ['牧場の朝仕事に参加する', '動物の世話と衛生管理を体験し、食を支える日常を知る。'],
  ] },
  { category: '公共とデザイン', resources: ['調査力', '提案', '公共参加'], connections: ['公共空間', 'デザイン'], helpedByTags: ['accessibility', 'information_architecture'], actions: [
    ['公園の使われ方を観察して提案する', '時間帯ごとの利用を記録し、居心地を高める案をまとめる。'],
    ['公共サインの分かりやすさを調べる', '迷う地点と表示を比べ、誰にでも伝わる改善を考える。'],
    ['図書館の新しい居場所を一緒に考える', '利用者の声を集め、読書以外にも開かれた空間を提案する。'],
    ['地域予算の使い道を対話する会へ出る', '資料を読み、暮らしの優先課題について意見を交わす。'],
    ['災害時の情報カードをデザインする', '必要な行動を短く整理し、緊急時にも読める形にする。'],
    ['子どもの視点で通学路を点検する', '危険や安心できる場所を歩いて確かめ、改善案を共有する。'],
  ] },
];

const recipePresets: VisualRecipe[] = [
  { visualTheme: 'field_science', dominantMotif: 'insect_observation', secondaryObjects: ['observation_box', 'path', 'cultivation_patch'], terrainProfile: 'raised', accentPalette: 'green_amber', density: 'medium', openness: 'balanced', landmarkEmphasis: 'high', energyLevel: 'calm' },
  { visualTheme: 'creative', dominantMotif: 'camera', secondaryObjects: ['table', 'light', 'sign'], terrainProfile: 'organic', accentPalette: 'warm_red_white', density: 'medium', openness: 'balanced', landmarkEmphasis: 'high', energyLevel: 'moderate' },
  { visualTheme: 'culture', dominantMotif: 'meeting_point', secondaryObjects: ['pavilion', 'sign', 'path'], terrainProfile: 'organic', accentPalette: 'warm_cream_terracotta', density: 'dense', openness: 'balanced', landmarkEmphasis: 'high', energyLevel: 'moderate' },
  { visualTheme: 'food_craft', dominantMotif: 'bakery_workshop', secondaryObjects: ['table', 'crate', 'sign'], terrainProfile: 'organic', accentPalette: 'warm_cream_terracotta', density: 'dense', openness: 'compact', landmarkEmphasis: 'high', energyLevel: 'moderate' },
  { visualTheme: 'research', dominantMotif: 'observatory', secondaryObjects: ['utility', 'light', 'path'], terrainProfile: 'raised', accentPalette: 'ocean_teal', density: 'medium', openness: 'open', landmarkEmphasis: 'high', energyLevel: 'calm' },
  { visualTheme: 'cultivation', dominantMotif: 'windmill', secondaryObjects: ['cultivation_patch', 'shelter', 'path'], terrainProfile: 'organic', accentPalette: 'green_amber', density: 'dense', openness: 'balanced', landmarkEmphasis: 'medium', energyLevel: 'calm' },
  { visualTheme: 'outdoor_recreation', dominantMotif: 'campsite_marker', secondaryObjects: ['tent', 'firepit', 'path'], terrainProfile: 'raised', accentPalette: 'green_amber', density: 'sparse', openness: 'open', landmarkEmphasis: 'high', energyLevel: 'high' },
  { visualTheme: 'performance', dominantMotif: 'stage', secondaryObjects: ['speaker_stack', 'light_rig', 'audience_area'], terrainProfile: 'flat', accentPalette: 'warm_red_white', density: 'dense', openness: 'balanced', landmarkEmphasis: 'high', energyLevel: 'high' },
  { visualTheme: 'transport', dominantMotif: 'road_vehicle', secondaryObjects: ['route_board', 'transit_stop', 'road_loop'], terrainProfile: 'flat', accentPalette: 'ocean_teal', density: 'medium', openness: 'open', landmarkEmphasis: 'high', energyLevel: 'moderate' },
  { visualTheme: 'guided_experience', dominantMotif: 'guide_marker', secondaryObjects: ['tour_map', 'meeting_point', 'sign'], terrainProfile: 'organic', accentPalette: 'warm_cream_terracotta', density: 'medium', openness: 'balanced', landmarkEmphasis: 'high', energyLevel: 'moderate' },
  { visualTheme: 'observation', dominantMotif: 'observation_marker', secondaryObjects: ['binoculars', 'observation_box', 'path'], terrainProfile: 'raised', accentPalette: 'ocean_teal', density: 'sparse', openness: 'open', landmarkEmphasis: 'medium', energyLevel: 'calm' },
  { visualTheme: 'athletics', dominantMotif: 'running_track', secondaryObjects: ['hurdle', 'timing_board', 'sign'], terrainProfile: 'flat', accentPalette: 'warm_red_white', density: 'medium', openness: 'open', landmarkEmphasis: 'high', energyLevel: 'high' },
];

const nodeKinds: PossibilityNode['nodeKind'][] = ['experience', 'activity', 'skill', 'community', 'opportunity', 'information'];

export const PUBLIC_SAMPLE_NODES: PossibilityNode[] = domains.flatMap((domain, domainIndex) => domain.actions.map(([title, shortDescription], actionIndex) => {
  const index = domainIndex * 6 + actionIndex;
  return {
    id: `sample_${String(index + 1).padStart(3, '0')}`,
    title,
    shortDescription,
    category: domain.category,
    nodeKind: nodeKinds[(domainIndex + actionIndex) % nodeKinds.length],
    relationToGoal: index < 12 ? 'direct' : index < 48 ? 'adjacent' : 'exploratory',
    curiosityFit: .58 + ((index * 7) % 35) / 100,
    accessibility: .48 + ((index * 11) % 43) / 100,
    novelty: .44 + ((index * 13) % 48) / 100,
    friction: .18 + ((index * 5) % 55) / 100,
    portableResourceTags: [domain.resources[actionIndex % 3], domain.resources[(actionIndex + 1) % 3]],
    connectionTags: [...domain.connections],
    helpedByTags: [...(domain.helpedByTags ?? [])],
    visualRecipe: structuredClone(recipePresets[(domainIndex + actionIndex) % recipePresets.length]),
  } satisfies PossibilityNode;
}));

if (PUBLIC_SAMPLE_NODES.length !== TARGET_WORLD_NODE_COUNT) {
  throw new Error(`Public sample catalog must contain exactly ${TARGET_WORLD_NODE_COUNT} Nodes.`);
}

export const sampleNodesForBand = (band: number) => {
  const start = INITIAL_WORLD_NODE_COUNT + (band - 1) * WORLD_EXPANSION_BATCH_SIZE;
  return PUBLIC_SAMPLE_NODES.slice(start, start + WORLD_EXPANSION_BATCH_SIZE).map((node) => structuredClone(node));
};

export function createSampleNodeDetail(node: PossibilityNode): NodeDetail {
  return {
    overview: `${node.shortDescription} このサンプルでは、実際に動くときの入口を具体的に想像できるよう、固定の説明を表示しています。`,
    expectedOutcomes: [
      `${node.portableResourceTags[0]}を実践の中で得るきっかけ`,
      `${node.connectionTags[0]}に関わる人や場所との接点`,
      '試した過程を振り返れる小さな記録',
    ],
    personConnection: 'これは一般公開サンプルの例です。あなた自身のPerson Mapとの接続は、AIリアルタイム版で個別に組み立てられます。',
  };
}

export function createSampleSmallSteps(node: PossibilityNode): LocalSmallStep[] {
  const bridgeTags: CanonicalBridgeTag[] = node.helpedByTags?.length ? [...node.helpedByTags] : ['project_management'];
  return [
    { id: `${node.id}_step_1`, title: '入口を調べる', shortDescription: `${node.title}を試せる場所・人・必要な準備を一つ確認する。`, portableResources: ['情報', node.portableResourceTags[0]], connectionTags: [node.connectionTags[0]], experienceTag: `${node.category}_research`, connectionBridgeTags: bridgeTags },
    { id: `${node.id}_step_2`, title: '小さく試してみる', shortDescription: '30分から半日でできる最小の形にして、実際に手を動かす。', portableResources: ['小さな実践', node.portableResourceTags[1]], connectionTags: [node.connectionTags[1]], experienceTag: `${node.category}_prototype`, experienceBridgeTags: bridgeTags },
    { id: `${node.id}_step_3`, title: '気づきを一つ残す', shortDescription: 'やってみて分かったことを短く記録し、次の一歩を決める。', portableResources: ['振り返り', '経験'], connectionTags: [node.connectionTags[0]], experienceTag: `${node.category}_reflection`, resourceBridges: [{ resource: '振り返り', bridgeTags }] },
  ];
}

export const createSampleProductState = (): PersistedProductState => ({
  version: PRODUCT_STATE_SCHEMA_VERSION,
  personState: {
    interests: ['新しい分野を見て回る', '身近な地域で試す'],
    engagementPatterns: ['小さく試して振り返る'],
    constraints: ['まずは無理のない範囲で始めたい'],
    recentChanges: ['視野を広げたい'],
    portableResources: [], experiences: [], completedSteps: [], bridgeTags: [],
  },
  userProfile: {
    nickname: 'サンプル航海者',
    region: { countryCode: 'JP', administrativeArea: 'サンプル地域' },
    practicalProfile: ['一般公開デモ'],
    updatedAt: '2026-10-24T00:00:00.000Z',
  },
  onboardingComplete: true,
  personContextRevision: 1,
  observedPersonSignals: [],
});

export function createSampleProductStateRepository(storage: BrowserStorage): ProductStateRepository {
  return {
    load: () => {
      const raw = storage.getItem(SAMPLE_PRODUCT_STATE_KEY);
      return raw ? parsePersistedProductState(raw) : createSampleProductState();
    },
    save: (state) => storage.setItem(SAMPLE_PRODUCT_STATE_KEY, JSON.stringify(state)),
    clear: () => storage.removeItem(SAMPLE_PRODUCT_STATE_KEY),
  };
}

export function createSampleWorldRepository(factory: IDBFactory = globalThis.indexedDB): WorldRepository {
  return createIndexedDbWorldRepository(factory, { databaseName: SAMPLE_WORLD_DATABASE_NAME });
}

export function createInitialSampleWorld(): PersistedWorldSnapshotV1 {
  const nodes = PUBLIC_SAMPLE_NODES.slice(0, INITIAL_WORLD_NODE_COUNT).map((node) => structuredClone(node));
  const tiers = initialWorldTiers(nodes);
  const nodeStates = Object.fromEntries(nodes.map((node) => [node.id, {
    visible: true, visited: false, kept: false, activePursuit: false, landed: false,
    worldTier: tiers[node.id], completedStepIds: [],
  } satisfies PossibilityNodeState]));
  return {
    schemaVersion: WORLD_SCHEMA_VERSION,
    worldId: SAMPLE_WORLD_ID,
    worldRevision: 1,
    savedAt: '2026-10-24T00:00:00.000Z',
    layoutVersion: WORLD_LAYOUT_VERSION,
    context: { contextSeed: '一般公開サンプル120島', locale: 'ja', initialPersonContextRevision: 1, integratedPersonContextRevision: 1 },
    nodes,
    nodeStates,
    explorationBands: Object.fromEntries(nodes.map((node) => [node.id, 0])),
    generatedBatches: [{ band: 0, nodeIds: nodes.map((node) => node.id) }],
    stepCatalog: {}, detailCache: {}, ship: { settledPosition: { x: 0, y: 310 } }, selectedNodeId: null,
  };
}

export type SampleNetworkDiagnostic = { blockedCount: number; blockedTargets: string[] };

declare global {
  interface Window { __kurohigePublicSample?: SampleNetworkDiagnostic; }
}

const requestTarget = (input: RequestInfo | URL) => input instanceof Request ? input.url : String(input);
const isBlockedSampleTarget = (target: string, baseUrl: string) => {
  try {
    const url = new URL(target, baseUrl);
    return (url.origin === new URL(baseUrl).origin && url.pathname.startsWith('/api/'))
      || /(^|\.)api\.studio\.nebius\.ai$/iu.test(url.hostname)
      || /(^|\.)nebius\.ai$/iu.test(url.hostname);
  } catch {
    return true;
  }
};

export function createSampleFetchGuard(
  fetchImplementation: typeof fetch,
  baseUrl = 'http://127.0.0.1/',
  diagnostic: SampleNetworkDiagnostic = { blockedCount: 0, blockedTargets: [] },
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = requestTarget(input);
    if (!isBlockedSampleTarget(target, baseUrl)) return fetchImplementation(input, init);
    diagnostic.blockedCount += 1;
    diagnostic.blockedTargets.push(target);
    return new Response(JSON.stringify({ error: {
      code: SAMPLE_API_BLOCK_CODE,
      message: '一般公開サンプルではAI生成と本番データAPIを使用できません。',
    } }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

export function installSampleFetchGuard() {
  const diagnostic: SampleNetworkDiagnostic = { blockedCount: 0, blockedTargets: [] };
  window.__kurohigePublicSample = diagnostic;
  window.fetch = createSampleFetchGuard(window.fetch.bind(window), window.location.href, diagnostic);
}

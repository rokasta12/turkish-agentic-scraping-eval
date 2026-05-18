export type SeedSite = {
  url: string;
  label: string;
  category: 'public' | 'news' | 'culture' | 'education' | 'commerce-smoke';
  maxPages: number;
};

export const TURKISH_SEEDS: SeedSite[] = [
  { url: 'https://www.resmigazete.gov.tr/', label: 'Resmi Gazete', category: 'public', maxPages: 2 },
  { url: 'https://www.tuik.gov.tr/', label: 'TUIK', category: 'public', maxPages: 2 },
  { url: 'https://www.mgm.gov.tr/', label: 'Meteoroloji Genel Mudurlugu', category: 'public', maxPages: 2 },
  { url: 'https://www.trthaber.com/', label: 'TRT Haber', category: 'news', maxPages: 2 },
  { url: 'https://www.aa.com.tr/tr', label: 'Anadolu Ajansi', category: 'news', maxPages: 2 },
  { url: 'https://www.bbc.com/turkce', label: 'BBC Turkce', category: 'news', maxPages: 1 },
  { url: 'https://islamansiklopedisi.org.tr/', label: 'TDV Islam Ansiklopedisi', category: 'culture', maxPages: 1 },
  { url: 'https://dergipark.org.tr/tr/', label: 'DergiPark', category: 'education', maxPages: 1 }
];

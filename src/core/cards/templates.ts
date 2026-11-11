export type Category = { name: string; hint: string }
export type Template = { id: string; name: string; categories: Category[] }

/** Folder for clips the classifier could not place (or whose classification failed). */
export const UNCLASSIFIED = '_nezařazeno'
/** Folder for non-video files found on the card. */
export const OTHER_FILES = '_ostatni'

export const DEFAULT_TEMPLATES: Template[] = [
  {
    id: 'fotbal',
    name: 'Fotbal',
    categories: [
      {
        name: 'Trénink',
        hint: 'trénink a tisková konference den před zápasem, detaily prázdného stadionu',
      },
      { name: 'předzápas', hint: 'příchod a procházka hráčů v oblecích po hřišti' },
      { name: 'rozcvička', hint: 'rozcvička týmů a brankářů na hřišti před zápasem' },
      {
        name: 'nástup',
        hint: 'tunel, nástup s dětmi, hymna, týmová fotka, funkcionáři před nástupem',
      },
      { name: 'Zápas', hint: 'samotná hra, akce, šance, fanoušci během zápasu' },
      {
        name: 'děkovačka',
        hint: 'poděkování fanouškům po zápase, odchod ze hřiště, rozhovory po zápase',
      },
    ],
  },
  {
    id: 'tenis',
    name: 'Tenis',
    categories: [
      { name: 'Hra', hint: 'hra a hráči na kurtu včetně oslav po bodu' },
      { name: 'Fanoušci', hint: 'tribuny, kotel, vlajky, reakce diváků' },
      { name: 'Lavička', hint: 'kapitán a tým na lavičce' },
      { name: 'Nástup', hint: 'nástup, hymna, los, světelná show' },
      { name: 'Sponzoři', hint: 'reklamní plochy a sponzorské prvky' },
    ],
  },
]

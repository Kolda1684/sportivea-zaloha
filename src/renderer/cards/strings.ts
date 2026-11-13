/** Fixed UI strings (the final confirmation must never be reworded). */
export const NOT_BACKED_UP = 'Karta ještě NENÍ zálohovaná'
export const FINAL_OK_MESSAGE =
  'Zapsáno a ověřeno. Kartu můžeš vytáhnout. Drive dokončuje upload, kartu formátuj až po jeho dokončení (ikona Drive v liště).'
export const ABORTED_MESSAGE = 'Třídění bylo přerušeno. Karta NENÍ celá zálohovaná — spusť ji znovu, nahraje se jen zbytek.'
export const CARD_REMOVED_MESSAGE = 'Karta byla odpojena. Nic se nesmazalo — zasuň ji znovu a spusť znovu, nahraje se jen zbytek.'
export const VERIFY_FAILED_MESSAGE = 'Tyto soubory se nepodařilo ověřit. Karta NENÍ zálohovaná.'
export const WAITING_SPACE_MESSAGE = 'Čekám, až Google Drive uvolní místo na disku…'
export const TOOLS_MISSING_MESSAGE = 'Chybí nástroj ffprobe/ffmpeg — aplikace je poškozená, kontaktuj Jana.'
export const NOT_BACKED_UP_HEADING = 'Pozor — karta NENÍ celá zálohovaná'
export const AI_UNAVAILABLE_MESSAGE = 'AI nedostupná — zbytek zálohován bez třídění.'
export const KEY_MISSING_HINT = 'Bez klíče ke Claude nejde třídit ani pojmenovávat. Kartu můžeš jen nahrát beze změny.'
export const COPY_DONE_MESSAGE = 'Nahráno beze změny: všechny soubory jsou s původními názvy přímo ve složce akce.'
/** Label of the event folder itself in the Done table ('name' and 'copy' modes put files there). */
export const EVENT_ROOT_LABEL = 'přímo ve složce akce'
/** The three things that can be done with a card, in the order shown. */
export const CARD_MODES = [
  { mode: 'sort', label: 'Roztřídit a pojmenovat', hint: 'Claude klipy roztřídí do složek podle šablony a pojmenuje je.' },
  { mode: 'name', label: 'Jen pojmenovat', hint: 'Claude klipy pojmenuje, ale všechny jdou rovnou do složky akce, bez třídění.' },
  { mode: 'copy', label: 'Jen nahrát', hint: 'Všechny soubory z karty s původními názvy rovnou do složky akce. Bez Clauda, nic se nepřejmenuje.' },
] as const
export const NO_AI_DONE_MESSAGE = 'Zálohováno bez třídění: všechny klipy jsou ve složce _nezařazeno, roztřiď je ručně.'

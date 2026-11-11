import { HOME_CARDS, HOME_CARDS_SUB, HOME_DOWNLOAD, HOME_DOWNLOAD_SUB } from './strings'

type HomeProps = {
  downloadStatus: string | null
  cardsStatus: string | null
  onDownload: () => void
  onCards: () => void
}

/** The two choices of the app, each with the state of its mode when something runs. */
export function Home({ downloadStatus, cardsStatus, onDownload, onCards }: HomeProps) {
  return (
    <div className="home">
      <button type="button" className="home-choice home-download" onClick={onDownload}>
        <span className="home-title">{HOME_DOWNLOAD}</span>
        <span className="home-sub">{HOME_DOWNLOAD_SUB}</span>
        {downloadStatus !== null && <span className="home-status">{downloadStatus}</span>}
      </button>
      <button type="button" className="home-choice home-cards" onClick={onCards}>
        <span className="home-title">{HOME_CARDS}</span>
        <span className="home-sub">{HOME_CARDS_SUB}</span>
        {cardsStatus !== null && <span className="home-status">{cardsStatus}</span>}
      </button>
    </div>
  )
}

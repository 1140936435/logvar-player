import { memo, type ReactElement } from 'react'
import { TvMinimal, Film, Folder, ImagePlus } from 'lucide-react'
import { LazyImage } from './LazyImage'

interface MediaItem {
  Id: string
  Name: string
  Type: string
  IsFolder?: boolean
  ChildCount?: number
  CommunityRating?: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CollectionType?: string
}

interface MediaCardProps {
  item: MediaItem
  posterUrl: string | null
  displayName: string
  communityRating?: number | null
  onClick: () => void
  onScrape?: () => void
}

export const MediaCard = memo(function MediaCard({
  item,
  posterUrl,
  displayName,
  communityRating,
  onClick,
  onScrape,
}: MediaCardProps): ReactElement {
  const isFolder = item.IsFolder || (!!item.ChildCount && item.ChildCount > 0)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyItem = item as any
  const isTv = anyItem.CollectionType === 'tvshows'
  const isMovie = anyItem.CollectionType === 'movies'
  const collectionIcon = isTv
    ? <TvMinimal size={28} className="text-[var(--text-quaternary)]" />
    : isMovie
      ? <Film size={28} className="text-[var(--text-quaternary)]" />
      : <Folder size={28} className="text-[var(--text-quaternary)]" />

  const fallbackIcon = (
    <div className="w-full h-full flex items-center justify-center bg-[var(--bg-elevated)]">
      {collectionIcon}
    </div>
  )

  return (
    <div
      onClick={onClick}
      className="media-card group cursor-pointer"
      style={{ aspectRatio: '2/3' }}
    >
      <div className="media-card-poster w-full h-full relative">
        <LazyImage
          src={posterUrl}
          alt={item.Name}
          className="w-full h-full relative"
          fallback={fallbackIcon}
        />
      </div>

      {onScrape && (
        <button
          onClick={(e) => { e.stopPropagation(); onScrape() }}
          className="absolute top-2 left-2 w-6 h-6 rounded-md bg-black/50 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-20"
        >
          <ImagePlus size={12} className="text-white/80" />
        </button>
      )}

      {communityRating != null && communityRating > 0 && (
        <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-[var(--accent)]/90 text-white backdrop-blur-sm shadow-sm z-10">
          ★ {communityRating.toFixed(1)}
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 p-2.5 bg-gradient-to-t from-black/70 via-black/30 to-transparent opacity-60 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-10">
        <p className="text-[11px] text-white/90 font-medium truncate drop-shadow-lg group-hover:text-white transition-colors duration-200">{displayName}</p>
      </div>

      {isFolder && item.Type !== 'Series' && (
        <div className="absolute top-2 right-2 px-2 py-0.5 bg-[var(--accent)]/90 backdrop-blur-sm rounded-md text-[10px] font-semibold text-white z-10">
          {item.ChildCount ? `${item.ChildCount}项` : '文件夹'}
        </div>
      )}
    </div>
  )
})
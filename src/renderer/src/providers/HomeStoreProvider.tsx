import React, { createContext, useContext, useReducer, useEffect, ReactNode } from 'react';

interface MediaLibrary {
  Id: string;
  Name: string;
  Type: string;
}

interface MediaItem {
  Id: string;
  Name: string;
  ImageTags?: Record<string, string>;
  Type: string;
  PremiereDate?: string;
  CommunityRating?: number;
  ProductionYear?: number;
  Overview?: string;
  RunTimeTicks?: number;
}

interface DrillLevel {
  libraryId: string;
  libraryName: string;
  itemType?: string;
  parentId?: string;
}

interface RecentlyAddedItem {
  itemId: string;
  name: string;
  imageTag: string;
  type: string;
  date: string;
}

interface PlaybackHistoryItem {
  itemId: string;
  name: string;
  imageTag: string;
  type: string;
  progress: number;
  date: string;
}

export interface HomeStoreState {
  libraries: MediaLibrary[];
  libraryItems: Record<string, MediaItem[]>;
  libraryTotalCounts: Record<string, number>;
  drillStack: DrillLevel[];
  scrollPosition: Record<string, number>;
  recentlyAdded: RecentlyAddedItem[];
  recentPlayback: PlaybackHistoryItem[];
  lastUpdateTime: number;
}

type HomeStoreAction =
  | { type: 'SET_LIBRARIES'; payload: MediaLibrary[] }
  | { type: 'SET_LIBRARY_ITEMS'; payload: { libraryId: string; items: MediaItem[] } }
  | { type: 'SET_LIBRARY_TOTAL_COUNT'; payload: { libraryId: string; count: number } }
  | { type: 'SET_DRILL_STACK'; payload: DrillLevel[] }
  | { type: 'SET_SCROLL_POSITION'; payload: { key: string; position: number } }
  | { type: 'SET_RECENTLY_ADDED'; payload: RecentlyAddedItem[] }
  | { type: 'SET_RECENT_PLAYBACK'; payload: PlaybackHistoryItem[] }
  | { type: 'INVALIDATE' }
  | { type: 'RESTORE'; payload: HomeStoreState };

const initialState: HomeStoreState = {
  libraries: [],
  libraryItems: {},
  libraryTotalCounts: {},
  drillStack: [],
  scrollPosition: {},
  recentlyAdded: [],
  recentPlayback: [],
  lastUpdateTime: 0,
};

function homeStoreReducer(state: HomeStoreState, action: HomeStoreAction): HomeStoreState {
  switch (action.type) {
    case 'SET_LIBRARIES':
      return { ...state, libraries: action.payload, lastUpdateTime: Date.now() };
    case 'SET_LIBRARY_ITEMS':
      return {
        ...state,
        libraryItems: { ...state.libraryItems, [action.payload.libraryId]: action.payload.items },
        lastUpdateTime: Date.now(),
      };
    case 'SET_LIBRARY_TOTAL_COUNT':
      return {
        ...state,
        libraryTotalCounts: { ...state.libraryTotalCounts, [action.payload.libraryId]: action.payload.count },
      };
    case 'SET_DRILL_STACK':
      return { ...state, drillStack: action.payload };
    case 'SET_SCROLL_POSITION':
      return {
        ...state,
        scrollPosition: { ...state.scrollPosition, [action.payload.key]: action.payload.position },
      };
    case 'SET_RECENTLY_ADDED':
      return { ...state, recentlyAdded: action.payload, lastUpdateTime: Date.now() };
    case 'SET_RECENT_PLAYBACK':
      return { ...state, recentPlayback: action.payload, lastUpdateTime: Date.now() };
    case 'INVALIDATE':
      return { ...initialState, lastUpdateTime: 0 };
    case 'RESTORE':
      return action.payload;
    default:
      return state;
  }
}

interface HomeStoreContextType {
  state: HomeStoreState;
  setLibraries: (libraries: MediaLibrary[]) => void;
  setLibraryItems: (libraryId: string, items: MediaItem[]) => void;
  setLibraryTotalCount: (libraryId: string, count: number) => void;
  setDrillStack: (stack: DrillLevel[]) => void;
  setScrollPosition: (key: string, position: number) => void;
  setRecentlyAdded: (items: RecentlyAddedItem[]) => void;
  setRecentPlayback: (items: PlaybackHistoryItem[]) => void;
  invalidate: () => void;
  isFresh: () => boolean;
}

const HomeStoreContext = createContext<HomeStoreContextType | null>(null);

const STORAGE_KEY = 'logvar-home-store';
const CACHE_TTL = 5 * 60 * 1000;

export function HomeStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(homeStoreReducer, initialState);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as HomeStoreState;
        if (parsed.libraries && parsed.libraries.length > 0) {
          dispatch({ type: 'RESTORE', payload: parsed });
        }
      }
    } catch {
      console.error('[HomeStore] Failed to restore from localStorage');
    }
  }, []);

  useEffect(() => {
    if (state.libraries.length > 0) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        console.error('[HomeStore] Failed to save to localStorage');
      }
    }
  }, [state]);

  const setLibraries = (libraries: MediaLibrary[]) => dispatch({ type: 'SET_LIBRARIES', payload: libraries });
  const setLibraryItems = (libraryId: string, items: MediaItem[]) => dispatch({ type: 'SET_LIBRARY_ITEMS', payload: { libraryId, items } });
  const setLibraryTotalCount = (libraryId: string, count: number) => dispatch({ type: 'SET_LIBRARY_TOTAL_COUNT', payload: { libraryId, count } });
  const setDrillStack = (stack: DrillLevel[]) => dispatch({ type: 'SET_DRILL_STACK', payload: stack });
  const setScrollPosition = (key: string, position: number) => dispatch({ type: 'SET_SCROLL_POSITION', payload: { key, position } });
  const setRecentlyAdded = (items: RecentlyAddedItem[]) => dispatch({ type: 'SET_RECENTLY_ADDED', payload: items });
  const setRecentPlayback = (items: PlaybackHistoryItem[]) => dispatch({ type: 'SET_RECENT_PLAYBACK', payload: items });
  const invalidate = () => {
    dispatch({ type: 'INVALIDATE' });
    localStorage.removeItem(STORAGE_KEY);
  };
  const isFresh = () => Date.now() - state.lastUpdateTime < CACHE_TTL;

  return (
    <HomeStoreContext.Provider value={{
      state,
      setLibraries,
      setLibraryItems,
      setLibraryTotalCount,
      setDrillStack,
      setScrollPosition,
      setRecentlyAdded,
      setRecentPlayback,
      invalidate,
      isFresh,
    }}>
      {children}
    </HomeStoreContext.Provider>
  );
}

export function useHomeStore() {
  const context = useContext(HomeStoreContext);
  if (!context) {
    throw new Error('useHomeStore must be used within a HomeStoreProvider');
  }
  return context;
}

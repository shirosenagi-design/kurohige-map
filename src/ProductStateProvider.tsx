import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type Dispatch, type ReactNode } from 'react';
import {
  createInitialProductState,
  createLocalStorageProductStateRepository,
  persistedSnapshot,
  productStateReducer,
  type ProductState,
  type ProductStateAction,
  type ProductStateRepository,
} from './productState';
import { notifyProductStatePersisted } from './localPersistenceSignals';

type ProductStateContextValue = {
  state: ProductState;
  dispatch: Dispatch<ProductStateAction>;
  repository: ProductStateRepository;
};

const ProductStateContext = createContext<ProductStateContextValue | null>(null);

export function ProductStateProvider({ children, repository }: {
  children: ReactNode;
  repository?: ProductStateRepository;
}) {
  const defaultRepository = useRef<ProductStateRepository | null>(null);
  if (!defaultRepository.current) defaultRepository.current = createLocalStorageProductStateRepository(window.localStorage);
  const activeRepository = repository ?? defaultRepository.current;
  const [state, dispatch] = useReducer(productStateReducer, undefined, () => createInitialProductState(activeRepository.load()));

  useEffect(() => {
    try {
      const snapshot = persistedSnapshot(state);
      activeRepository.save(snapshot);
      notifyProductStatePersisted(snapshot);
    } catch (error) {
      console.warn('KUROHIGE MAP could not persist personal product state.', error);
    }
  }, [activeRepository, state.personState, state.userProfile, state.onboardingComplete, state.personContextRevision, state.observedPersonSignals]);

  const value = useMemo(() => ({ state, dispatch, repository: activeRepository }), [activeRepository, state]);
  return <ProductStateContext.Provider value={value}>{children}</ProductStateContext.Provider>;
}

export function useProductState() {
  const value = useContext(ProductStateContext);
  if (!value) throw new Error('useProductState must be used inside ProductStateProvider.');
  return value;
}

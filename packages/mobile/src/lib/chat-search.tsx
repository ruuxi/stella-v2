import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

type ChatSearchValue = {
  /** Current query text. Empty string means "not filtering". */
  query: string;
  /** Whether the search field is expanded in the top bar. */
  isOpen: boolean;
  setQuery: (next: string) => void;
  open: () => void;
  /** Collapse the field and clear the query. */
  close: () => void;
};

const ChatSearchContext = createContext<ChatSearchValue>({
  query: "",
  isOpen: false,
  setQuery: () => {},
  open: () => {},
  close: () => {},
});

/**
 * Shared chat-search state. Lives above both the top bar (which owns the
 * expanding search field) and the chat surfaces (which filter their message
 * list by the query), so the control and the result stay in sync without
 * threading props through the router.
 */
export function ChatSearchProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
  }, []);

  const value = useMemo(
    () => ({ query, isOpen, setQuery, open, close }),
    [query, isOpen, open, close],
  );

  return (
    <ChatSearchContext.Provider value={value}>
      {children}
    </ChatSearchContext.Provider>
  );
}

export const useChatSearch = () => useContext(ChatSearchContext);

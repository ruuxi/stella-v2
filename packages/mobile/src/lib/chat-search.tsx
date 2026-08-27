import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

type ChatSearchValue = {

  query: string;

  isOpen: boolean;
  setQuery: (next: string) => void;
  open: () => void;

  close: () => void;
};

const ChatSearchContext = createContext<ChatSearchValue>({
  query: "",
  isOpen: false,
  setQuery: () => {},
  open: () => {},
  close: () => {},
});

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

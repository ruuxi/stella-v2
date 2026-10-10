import { useCallback, useState } from "react";
import {
  deviceFileUnavailableMessage,
  type DeviceFileSource,
} from "@stella/contracts/device-files";

export type LocalMediaNoun = "video" | "audio file";

const filenameOf = (filePath: string): string =>
  filePath.split(/[\\/]/).pop() ?? filePath;

export const localMediaFailureMessage = (
  source: DeviceFileSource | null,
  filePath: string,
  noun: LocalMediaNoun,
): string =>
  !source || source.kind === "local" || source.kind === "drive"
    ? `Couldn't play ${filenameOf(filePath)}.`
    : deviceFileUnavailableMessage(source, filePath, noun);

const explainLocalMediaFailure = async (
  filePath: string,
  noun: LocalMediaNoun,
): Promise<string> => {
  const describe = window.electronAPI?.display?.mediaSource;
  const source = describe ? await describe(filePath).catch(() => null) : null;
  return localMediaFailureMessage(source, filePath, noun);
};

/**
 * Why a `stella-media:` stream for `filePath` failed, asked only once the
 * player reports an error: moved or deleted, kept on another device, or
 * present but unplayable.
 */
export const useLocalMediaFailure = (filePath: string, noun: LocalMediaNoun) => {
  const [failure, setFailure] = useState<{ filePath: string; message: string } | null>(
    null,
  );
  const onError = useCallback(() => {
    void explainLocalMediaFailure(filePath, noun).then((message) => {
      setFailure({ filePath, message });
    });
  }, [filePath, noun]);
  return {
    failure: failure?.filePath === filePath ? failure.message : null,
    onError,
  };
};

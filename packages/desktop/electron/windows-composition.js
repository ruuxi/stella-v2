import { app } from 'electron';

export const applyWindowsCompositionWorkarounds = () => {
  if (process.platform !== 'win32') {
    return false;
  }
  const disable = process.env.STELLA_DISABLE_MPO_FIX?.trim();
  if (disable === '1' || disable?.toLowerCase() === 'true') {
    console.log(
      '[composition] STELLA_DISABLE_MPO_FIX set — leaving DirectComposition/MPO at Chromium defaults',
    );
    return false;
  }
  app.commandLine.appendSwitch('disable-direct-composition');
  console.log(
    '[composition] Windows MPO flicker workaround active (--disable-direct-composition); set STELLA_DISABLE_MPO_FIX=1 to revert',
  );
  return true;
};

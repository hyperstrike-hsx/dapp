# Rendering environment

`bonzai-sky.hdr` is imported from the local `bonzai-desktop-dapp` rendering stack. In the range it is only the sky seen through the roof lights. Image-based lighting comes from a reflection probe captured from the lit room itself at load (`src/range/environment.ts`), so reflections and ambient light match the lamps, screens and furnace actually present.

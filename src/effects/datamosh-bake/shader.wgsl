// Datamosh Bake (M15): the bake's frame. The compositor draws it into this effect's pixels as it
// would a motion source (M14), so the effect just shows it. Until the bake is ready the effect is
// drawn as Datamosh (Engine A) instead, and this shader isn't used.

fn effect(px: vec2f) -> vec4f {
  return motionSourceLoad(vec2i(floor(px)));
}

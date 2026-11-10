#!/bin/bash
# Character and aircraft models for the viewer's Walk and Fly modes (not committed to git).
#   person.glb  three.js examples "Michelle" (Mixamo character, everyday clothes)
#   anims.glb   three.js examples "Soldier", used only for its Idle/Walk/Run animations (same Mixamo skeleton)
#   Mixamo-derived files: fine to use in the app, don't redistribute standalone
#   aerobatic_plane.glb Babylon.js Assets, CC BY 4.0 (credited in the viewer footer)
set -e
dir="$(dirname "$0")/../apps/viewer/public/models"
mkdir -p "$dir"
curl -sfL -o "$dir/person.glb" https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/Michelle.glb
curl -sfL -o "$dir/anims.glb"  https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/Soldier.glb
curl -sfL -o "$dir/plane.glb"  https://raw.githubusercontent.com/BabylonJS/Assets/master/meshes/aerobatic_plane.glb
ls -la "$dir"

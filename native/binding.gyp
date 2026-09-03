{
  "targets": [
    {
      "target_name": "starmemory_native",
      "sources": ["binding.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../vendor-tenann/output/include",
        "../vendor-tenann/thirdparty/installed/include"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS=0"],
      "cflags_cc": ["-std=c++17", "-fexceptions"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_CFLAGS": ["-Xpreprocessor", "-fopenmp"]
      },
      "libraries": [
        "-Wl,-force_load,<(module_root_dir)/../vendor-tenann/output/lib/libtenann.a",
        "-Wl,-force_load,<(module_root_dir)/../vendor-tenann/thirdparty/installed/lib/libfaiss.a",
        "<(module_root_dir)/../vendor-tenann/thirdparty/installed/lib/libopenblas.a",
        "-L/opt/homebrew/opt/libomp/lib",
        "-lomp"
      ],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"]
    }
  ]
}

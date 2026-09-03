// N-API binding wrapping tenann's FaissHnsw index builder + searcher
// (see vendor-tenann/examples/faiss_hnsw_example.cc for the canonical
// C++ usage this mirrors).
#include <napi.h>

#include <memory>
#include <string>
#include <vector>

#include "tenann/factory/ann_searcher_factory.h"
#include "tenann/factory/index_factory.h"
#include "tenann/searcher/ann_searcher.h"
#include "tenann/searcher/id_filter.h"
#include "tenann/store/index_meta.h"

namespace {

tenann::MetricType ParseMetric(const std::string& s) {
  if (s == "l2") return tenann::MetricType::kL2Distance;
  if (s == "cosine") return tenann::MetricType::kCosineSimilarity;
  if (s == "cosine_distance") return tenann::MetricType::kCosineDistance;
  return tenann::MetricType::kInnerProduct;
}

tenann::IndexMeta BuildMeta(uint32_t dim, tenann::MetricType metric, bool is_vector_normed, int M,
                            int ef_construction, int ef_search) {
  tenann::IndexMeta meta;
  meta.SetMetaVersion(0);
  meta.SetIndexFamily(tenann::IndexFamily::kVectorIndex);
  meta.SetIndexType(tenann::IndexType::kFaissHnsw);
  meta.common_params()["dim"] = dim;
  meta.common_params()["is_vector_normed"] = is_vector_normed;
  meta.common_params()["metric_type"] = metric;
  meta.index_params()["efConstruction"] = ef_construction;
  meta.index_params()["M"] = M;
  meta.search_params()["efSearch"] = ef_search;
  return meta;
}

// Reads the shared {dim, metric, isVectorNormed, M, efConstruction, efSearch}
// option object used by both buildHnswIndex() and the HnswSearcher constructor.
tenann::IndexMeta MetaFromOptions(const Napi::Object& opts) {
  uint32_t dim = opts.Get("dim").As<Napi::Number>().Uint32Value();
  std::string metric_str = opts.Has("metric") ? opts.Get("metric").As<Napi::String>().Utf8Value()
                                              : std::string("inner_product");
  bool is_normed =
      opts.Has("isVectorNormed") ? opts.Get("isVectorNormed").As<Napi::Boolean>().Value() : false;
  int M = opts.Has("M") ? opts.Get("M").As<Napi::Number>().Int32Value() : 16;
  int ef_construction =
      opts.Has("efConstruction") ? opts.Get("efConstruction").As<Napi::Number>().Int32Value() : 40;
  int ef_search = opts.Has("efSearch") ? opts.Get("efSearch").As<Napi::Number>().Int32Value() : 64;
  return BuildMeta(dim, ParseMetric(metric_str), is_normed, M, ef_construction, ef_search);
}

// buildHnswIndex(options, vectors: Float32Array, ids: BigInt64Array, outputPath: string): void
//
// One-shot build: writes a fresh HNSW index file from a full vector batch.
// There is no incremental single-row insert in tenann's builder API, so the
// caller (recall-engine.ts) is expected to rebuild from all rows in LMDB's
// `vectors` sub-DB rather than append to a live graph.
Napi::Value BuildHnswIndex(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 4 || !info[0].IsObject() || !info[1].IsTypedArray() ||
      !info[2].IsTypedArray() || !info[3].IsString()) {
    Napi::TypeError::New(env, "buildHnswIndex(options, vectors, ids, outputPath)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object opts = info[0].As<Napi::Object>();
  uint32_t dim = opts.Get("dim").As<Napi::Number>().Uint32Value();
  Napi::Float32Array vectors = info[1].As<Napi::Float32Array>();
  Napi::BigInt64Array ids = info[2].As<Napi::BigInt64Array>();
  std::string output_path = info[3].As<Napi::String>().Utf8Value();

  size_t n = ids.ElementLength();
  if (vectors.ElementLength() != n * dim) {
    Napi::TypeError::New(env, "vectors.length must equal ids.length * dim")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::vector<int64_t> row_ids(n);
  for (size_t i = 0; i < n; i++) row_ids[i] = static_cast<int64_t>(ids[i]);

  tenann::ArraySeqView base_view{.data = reinterpret_cast<uint8_t*>(vectors.Data()),
                                 .dim = dim,
                                 .size = static_cast<uint32_t>(n),
                                 .elem_type = tenann::PrimitiveType::kFloatType};

  auto meta = MetaFromOptions(opts);

  try {
    auto builder = tenann::IndexFactory::CreateBuilderFromMeta(meta);
    builder->EnableCustomRowId().Open(output_path).Add({base_view}, row_ids.data()).Flush().Close();
  } catch (tenann::Error& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

// Wraps a loaded tenann::AnnSearcher. One instance per open index file;
// re-instantiate after buildHnswIndex() rewrites the file.
class HnswSearcher : public Napi::ObjectWrap<HnswSearcher> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func =
        DefineClass(env, "HnswSearcher", {InstanceMethod("search", &HnswSearcher::Search)});
    exports.Set("HnswSearcher", func);
    return exports;
  }

  explicit HnswSearcher(const Napi::CallbackInfo& info) : Napi::ObjectWrap<HnswSearcher>(info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsString()) {
      Napi::TypeError::New(env, "new HnswSearcher(options, indexPath)")
          .ThrowAsJavaScriptException();
      return;
    }
    Napi::Object opts = info[0].As<Napi::Object>();
    dim_ = opts.Get("dim").As<Napi::Number>().Uint32Value();
    std::string index_path = info[1].As<Napi::String>().Utf8Value();
    auto meta = MetaFromOptions(opts);
    try {
      searcher_ = tenann::AnnSearcherFactory::CreateSearcherFromMeta(meta);
      searcher_->ReadIndex(index_path);
    } catch (tenann::Error& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    }
  }

 private:
  // search(query: Float32Array, k: number, filterIds?: BigInt64Array)
  //   -> { ids: BigInt64Array, distances: Float32Array }
  //
  // filterIds, when given, restricts the search to that id set via tenann's
  // ArrayIdFilter -- this is the "efficient filtered search" path (§07 of
  // the design doc): the graph traversal itself skips non-matching nodes,
  // there is no post-hoc over-fetch-and-trim step.
  Napi::Value Search(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!searcher_ || !searcher_->is_index_loaded()) {
      Napi::Error::New(env, "index not loaded").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsNumber()) {
      Napi::TypeError::New(env, "search(query, k, filterIds?)").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    Napi::Float32Array query = info[0].As<Napi::Float32Array>();
    int64_t k = info[1].As<Napi::Number>().Int64Value();
    if (query.ElementLength() != dim_) {
      Napi::TypeError::New(env, "query length must equal dim").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    std::unique_ptr<tenann::ArrayIdFilter> filter;
    if (info.Length() >= 3 && info[2].IsTypedArray()) {
      Napi::BigInt64Array filter_ids = info[2].As<Napi::BigInt64Array>();
      size_t nf = filter_ids.ElementLength();
      std::vector<int64_t> ids(nf);
      for (size_t i = 0; i < nf; i++) ids[i] = static_cast<int64_t>(filter_ids[i]);
      filter = std::make_unique<tenann::ArrayIdFilter>(ids.data(), nf);
    }

    tenann::PrimitiveSeqView query_view{.data = reinterpret_cast<uint8_t*>(query.Data()),
                                        .size = dim_,
                                        .elem_type = tenann::PrimitiveType::kFloatType};

    std::vector<int64_t> result_ids(k, -1);
    std::vector<float> result_distances(k, 0.0f);

    try {
      searcher_->AnnSearch(query_view, k, result_ids.data(),
                           reinterpret_cast<uint8_t*>(result_distances.data()), filter.get());
    } catch (tenann::Error& e) {
      Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
      return env.Undefined();
    }

    // Trim faiss's -1 padding (fewer than k candidates were available).
    int64_t n_valid = 0;
    while (n_valid < k && result_ids[n_valid] != -1) n_valid++;

    auto out_ids = Napi::BigInt64Array::New(env, n_valid);
    auto out_dist = Napi::Float32Array::New(env, n_valid);
    for (int64_t i = 0; i < n_valid; i++) {
      out_ids[i] = result_ids[i];
      out_dist[i] = result_distances[i];
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("ids", out_ids);
    result.Set("distances", out_dist);
    return result;
  }

  std::shared_ptr<tenann::AnnSearcher> searcher_;
  uint32_t dim_ = 0;
};

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  exports.Set("buildHnswIndex", Napi::Function::New(env, BuildHnswIndex));
  return HnswSearcher::Init(env, exports);
}

}  // namespace

NODE_API_MODULE(starmemory_native, InitAll)

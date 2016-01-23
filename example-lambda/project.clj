(defproject example-lambda "0.1.0-SNAPSHOT"
  :description "FIXME: write description"
  :dependencies [[org.clojure/clojure "1.7.0"]
                 [org.clojure/data.json "0.2.6"]
                 [uswitch/lambada "0.1.0"]]
  :target-path "target/%s"
  :profiles {:uberjar {:aot :all}})

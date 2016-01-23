(ns example-lambda.core
  (:require [uswitch.lambada.core :refer [deflambdafn]]
            [clojure.data.json :as json]
            [clojure.java.io :as io]))

(deflambdafn lambda.Fn [in out ctx]
  (let [event (json/read (io/reader in) :key-fn keyword)]
    (with-open [writer (io/writer out)]
      (json/write {:message (:message event)} writer))))


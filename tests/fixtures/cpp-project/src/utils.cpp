#include "utils.h"
#include <algorithm>
#include <cctype>

namespace utils {
    std::string toUpper(const std::string& s) {
        std::string r = s;
        std::transform(r.begin(), r.end(), r.begin(), ::toupper);
        return r;
    }
    std::string toLower(const std::string& s) {
        std::string r = s;
        std::transform(r.begin(), r.end(), r.begin(), ::tolower);
        return r;
    }
    bool startsWith(const std::string& str, const std::string& prefix) {
        return str.rfind(prefix, 0) == 0;
    }
}
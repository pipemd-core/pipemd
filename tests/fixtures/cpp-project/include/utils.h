#pragma once
#include <map>
#include <string>

namespace utils {
    std::string toUpper(const std::string& s);
    std::string toLower(const std::string& s);
    bool startsWith(const std::string& str, const std::string& prefix);
}